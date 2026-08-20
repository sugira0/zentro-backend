// @ts-nocheck
// Zentro Business Management — main server entry point
// PostgreSQL (Neon) edition — replaces SQLite DatabaseSync

try { process.loadEnvFile() } catch {}

import { createServer }   from 'node:http'
import { readFile }       from 'node:fs/promises'
import { existsSync }     from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath }  from 'node:url'
import { randomUUID }     from 'node:crypto'
import { readFileSync }   from 'node:fs'

import { initDb }                        from '../server/db.ts'
import { initSchema }                    from '../server/schema-init.ts'
import { uploadToR2, handleUpload }      from '../server/r2.ts'

import { initOperations, operations }    from '../server/operations.ts'
import { initializeInventoryLink, deductOrderInventory } from '../server/inventory-link.ts'
import { initializeProductCatalog, listProducts, productDetail, createProduct, updateProduct, archiveProduct } from '../server/product-catalog.ts'
import { initializeBusinessModules, handleBusinessModules } from '../server/business-modules.ts'
import { initializeSaasPlatform, handleSaasPlatform }   from '../server/saas-platform.ts'
import { initializeAuth, handleAuth, authenticate, isSuperadmin, canAccessBusinessApi } from '../server/auth.ts'
import { handleGoogleAuth }              from '../server/google-auth.ts'
import { startSubscriptionExpiryScheduler } from '../server/tenant-subscription.ts'
import { initializeTenantCore, tenantContext, hasRequiredModule, recordTenantAudit } from '../server/tenant-core.ts'
import { initializePlatformAdmin, handlePlatformAdmin } from '../server/platform-admin.ts'
import { initializeReturns, handleReturns }             from '../server/returns.ts'
import { initializeNotifications, handleNotifications, notifyKitchen } from '../server/notifications.ts'
import { businessAnalytics }             from '../server/business-analytics.ts'
import { initializeInvoices, handleInvoices }           from '../server/invoices.ts'
import { initializeProforma, handleProforma }           from '../server/proforma.ts'
import { initializeCustomers, handleCustomers }         from '../server/customers.ts'
import { initializeTenantSystem, handleTenantSystem }   from '../server/tenant-system.ts'
import { initializeCashBank, handleCashBank }           from '../server/cash-bank.ts'
import { handleTenantBackups }           from '../server/tenant-backups.ts'
import { handleLoans }                   from '../server/loans.ts'
import { initializeSupportRequests, handleSupportRequests } from '../server/support.ts'
import { initializePlatformBackups, handlePlatformBackups, startBackupScheduler } from '../server/platform-backups.ts'
import { initializePublicContact, handlePublicContact } from '../server/public-contact.ts'
import { initializeLoanReminders, startLoanReminderScheduler } from '../server/loan-reminders.ts'
import { handleInventoryOverview }       from '../server/inventory-overview.ts'
import { initializeWarehouses, handleWarehouses }       from '../server/warehouses.ts'
import { initializeExpenses, handleExpenses }           from '../server/expenses.ts'
import { initializeAccounting, handleAccounting }       from '../server/accounting.ts'
import { initializePublicStorefront, handlePublicStorefront } from '../server/public-storefront.ts'
import { initializeRestaurantTables, handleRestaurantTables } from '../server/restaurant-tables.ts'

const DATABASE_URL = process.env.DATABASE_URL
const port = Number(process.env.PORT || 3001)

const send = (r, s, v) => {
  const b = JSON.stringify(v)
  r.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) })
  r.end(b)
}
const body = async req => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw ? JSON.parse(raw) : {}
}

async function main() {
  // ── 1. Start HTTP server FIRST so Railway healthcheck always passes ────────
  let db: any = null
  let ready = false
  const corsAllowlist = (process.env.CORS_ORIGIN || '').split(',').map(x => x.trim()).filter(Boolean)

  const orderView = async (id: any, tenant: any) => {
    const order = await db.prepare('SELECT * FROM orders WHERE id=? AND business_id=? AND branch_id=?').get(id, tenant.businessId, tenant.branchId)
    if (!order) return null
    const items = await db.prepare('SELECT menu_item_id AS "menuItemId", name, unit_price AS "unitPrice", quantity FROM order_items WHERE order_id=? AND business_id=?').all(id, tenant.businessId)
    return { ...order, items }
  }

  createServer(async (req, res) => {
    try {
      // CORS
      const requestOrigin = req.headers.origin
      if (corsAllowlist.length && requestOrigin && corsAllowlist.includes(requestOrigin)) {
        res.setHeader('Access-Control-Allow-Origin', requestOrigin)
        res.setHeader('Access-Control-Allow-Credentials', 'true')
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'content-type,x-zentro-portal')
        res.setHeader('Vary', 'Origin')
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

      const u = new URL(req.url, 'http://localhost')

      // Healthcheck always responds 200 regardless of DB state
      if (u.pathname === '/api/auth/me' && req.method === 'GET' && !ready) {
        return send(res, 200, { user: null, status: 'starting' })
      }

      // Return 503 until DB is ready (except healthcheck above)
      if (!ready) {
        return send(res, 503, { error: 'Server starting, please retry in a moment' })
      }

      // Public routes (no auth)
      if (await handlePublicStorefront(req, res, u, db)) return
      if (await handlePublicContact(req, res, u, db)) return
      if (await handleAuth(req, res, u, db)) return
      if (await handleGoogleAuth(req, res, u, db)) return

      // Image / file upload endpoint
      const uploadMatch = u.pathname.match(/^\/api\/upload\/(products|logos|documents)$/)
      if (uploadMatch && req.method === 'POST') {
        const authUser = await authenticate(req, db)
        if (!authUser) return send(res, 401, { error: 'Authentication required' })
        const handled = await handleUpload(req, res, uploadMatch[1], authUser.businessId ?? 'platform')
        if (handled) return
      }

      const authUser = await authenticate(req, db)
      const tenant   = await tenantContext(req, db, authUser)

      if (u.pathname.startsWith('/api/') && !authUser)
        return send(res, 401, { error: 'Authentication required' })

      if (u.pathname.startsWith('/api/platform/') && !isSuperadmin(authUser))
        return send(res, 403, { error: 'Superadmin access required' })

      if (u.pathname.startsWith('/api/platform/')) {
        if (await handlePlatformBackups(req, res, u, db, authUser)) return
        if (await handlePlatformAdmin(req, res, u, db, authUser)) return
        if (await handleSaasPlatform(req, res, u, db)) return
      } else if (u.pathname.startsWith('/api/') && (!tenant || !canAccessBusinessApi(req, u, authUser))) {
        return send(res, 403, { error: 'Your role cannot access this business operation' })
      }

      if (u.pathname.startsWith('/api/') && !hasRequiredModule(u.pathname, tenant))
        return send(res, 403, { error: 'This module is not enabled for your business' })

      await recordTenantAudit(db, tenant, req, u)

      if (tenant && await handleSupportRequests(req, res, u, db, tenant)) return
      if (tenant && await handleTenantSystem(req, res, u, db, tenant)) return
      if (tenant && await handleCashBank(req, res, u, db, tenant)) return
      if (tenant && await handleNotifications(req, res, u, db, tenant)) return
      if (tenant && await handleReturns(req, res, u, db, tenant)) return
      if (tenant && await handleInvoices(req, res, u, db, tenant)) return
      if (tenant && await handleProforma(req, res, u, db, tenant)) return
      if (tenant && await handleCustomers(req, res, u, db, tenant)) return
      if (tenant && await handleWarehouses(req, res, u, db, tenant)) return
      if (tenant && await handleExpenses(req, res, u, db, tenant)) return
      if (tenant && await handleAccounting(req, res, u, db, tenant)) return
      if (tenant && await handleLoans(req, res, u, db, tenant)) return
      if (tenant && await handleInventoryOverview(req, res, u, db, tenant)) return
      if (tenant && await handleBusinessModules(req, res, u, db, tenant)) return
      if (tenant && await handleTenantBackups(req, res, u, db, tenant)) return
      if (tenant && await handleRestaurantTables(req, res, u, db, tenant)) return

      // ── Products ────────────────────────────────────────────────────────
      if (req.method === 'GET' && u.pathname === '/api/products')
        return send(res, 200, await listProducts(db, tenant))
      if (req.method === 'POST' && u.pathname === '/api/products') {
        const result = await createProduct(db, await body(req), tenant)
        return send(res, result.status || 201, result)
      }
      const productRecord = u.pathname.match(/^\/api\/products\/(\d+)$/)
      if (req.method === 'GET' && productRecord) {
        const result = await productDetail(db, +productRecord[1], tenant)
        return result ? send(res, 200, result) : send(res, 404, { error: 'Product not found' })
      }
      if (req.method === 'PATCH' && productRecord) {
        const result = await updateProduct(db, +productRecord[1], await body(req), tenant)
        return send(res, result.status || 200, result)
      }
      if (req.method === 'DELETE' && productRecord) {
        const result = await archiveProduct(db, +productRecord[1], tenant)
        return send(res, result.status || 200, result)
      }

      // ── Menu ────────────────────────────────────────────────────────────
      if (req.method === 'GET' && u.pathname === '/api/menu')
        return send(res, 200, await db.prepare('SELECT id,name,category AS cat,price,favorite AS fav,image FROM menu_items WHERE business_id=? AND available=true ORDER BY id').all(tenant.businessId))
      if (req.method === 'GET' && u.pathname === '/api/menu/admin')
        return send(res, 200, await db.prepare('SELECT id,name,category,price,favorite,image,available FROM menu_items WHERE business_id=? ORDER BY category,name').all(tenant.businessId))
      if (req.method === 'GET' && u.pathname === '/api/categories')
        return send(res, 200, await db.prepare(`SELECT c.*,COUNT(m.id) "itemCount",SUM(CASE WHEN m.available THEN 1 ELSE 0 END) "availableCount",COALESCE(SUM(m.price),0) "catalogValue" FROM categories c LEFT JOIN menu_items m ON m.category=c.key AND m.business_id=c.business_id WHERE c.business_id=? GROUP BY c.id ORDER BY c.name`).all(tenant.businessId))
      if (req.method === 'POST' && u.pathname === '/api/categories') {
        const input = await body(req), name = String(input.name||'').trim(), key = String(input.key||name).trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')
        if (!name||!key) return send(res, 400, { error: 'Category name is required' })
        try {
          const result = await db.prepare('INSERT INTO categories(key,name,description,is_active,created_at,business_id) VALUES(?,?,?,true,NOW(),?) RETURNING id').run(key,name,input.description||'',tenant.businessId)
          return send(res, 201, { id: result.lastInsertRowid, key })
        } catch { return send(res, 409, { error: 'A category with this name or key already exists' }) }
      }
      const categoryItem = u.pathname.match(/^\/api\/categories\/(\d+)$/)
      if (req.method === 'PATCH' && categoryItem) {
        const input = await body(req), current = await db.prepare('SELECT * FROM categories WHERE id=? AND business_id=?').get(+categoryItem[1], tenant.businessId)
        if (!current) return send(res, 404, { error: 'Category not found' })
        await db.prepare('UPDATE categories SET name=?,description=?,is_active=? WHERE id=? AND business_id=?').run(input.name??current.name, input.description??current.description, input.isActive===undefined?current.is_active:Boolean(input.isActive), current.id, tenant.businessId)
        return send(res, 200, { ok: true })
      }
      if (req.method === 'POST' && u.pathname === '/api/menu') {
        const input = await body(req), price = Math.trunc(Number(input.price))
        if (!input.name||!input.category||!Number.isFinite(price)||price<0) return send(res, 400, { error: 'Name, category and a valid price are required' })
        const maxRow = await db.prepare('SELECT COALESCE(MAX(id),0)+1 AS id FROM menu_items').get()
        const id = Number(maxRow.id)
        const warehouse = await db.prepare('SELECT id FROM warehouses WHERE business_id=? AND branch_id=? ORDER BY created_at LIMIT 1').get(tenant.businessId, tenant.branchId)
        let imageUrl = input.image || null
        if (imageUrl?.startsWith('data:')) imageUrl = await uploadToR2(imageUrl, 'products', tenant.businessId) || null
        await db.prepare('INSERT INTO menu_items(id,name,category,price,favorite,image,available,business_id,warehouse_id) VALUES(?,?,?,?,?,?,true,?,?)').run(id, input.name.trim(), input.category.trim().toLowerCase(), price, input.favorite?true:false, imageUrl, tenant.businessId, warehouse?.id||null)
        return send(res, 201, { id })
      }
      const menuItem = u.pathname.match(/^\/api\/menu\/(\d+)$/)
      if (req.method === 'PATCH' && menuItem) {
        const input = await body(req), item = await db.prepare('SELECT * FROM menu_items WHERE id=? AND business_id=?').get(+menuItem[1], tenant.businessId)
        if (!item) return send(res, 404, { error: 'Menu item not found' })
        const price = input.price===undefined?item.price:Math.trunc(Number(input.price))
        if (!Number.isFinite(price)||price<0) return send(res, 400, { error: 'Invalid price' })
        let imageUrl = input.image===undefined?item.image:input.image
        if (imageUrl?.startsWith('data:')) imageUrl = await uploadToR2(imageUrl, 'products', tenant.businessId) || item.image
        await db.prepare('UPDATE menu_items SET name=?,category=?,price=?,favorite=?,image=?,available=? WHERE id=? AND business_id=?').run(input.name??item.name, input.category??item.category, price, input.favorite===undefined?item.favorite:Boolean(input.favorite), imageUrl, input.available===undefined?item.available:Boolean(input.available), item.id, tenant.businessId)
        return send(res, 200, { ok: true })
      }

      // ── Orders ──────────────────────────────────────────────────────────
      if (req.method === 'GET' && u.pathname === '/api/orders')
        return send(res, 200, await db.prepare('SELECT * FROM orders WHERE business_id=? AND branch_id=? ORDER BY created_at DESC LIMIT 50').all(tenant.businessId, tenant.branchId))
      const orderRecord = u.pathname.match(/^\/api\/orders\/([^/]+)$/)
      if (req.method === 'GET' && orderRecord) {
        const current = await orderView(orderRecord[1], tenant)
        return current ? send(res, 200, current) : send(res, 404, { error: 'Sales order not found' })
      }
      if (req.method === 'PATCH' && orderRecord) {
        const input = await body(req), allowed = ['OPEN','CONFIRMED','SHIPPED','DELIVERED','CANCELLED','HELD'], status = String(input.status||'').toUpperCase()
        if (!allowed.includes(status)) return send(res, 400, { error: 'Invalid sales order status' })
        const current = await db.prepare('SELECT * FROM orders WHERE id=? AND business_id=? AND branch_id=?').get(orderRecord[1], tenant.businessId, tenant.branchId)
        if (!current) return send(res, 404, { error: 'Sales order not found' })
        if (current.status==='PAID'&&status==='CANCELLED') return send(res, 409, { error: 'A paid order must be returned or refunded, not cancelled' })
        await db.prepare('UPDATE orders SET status=? WHERE id=? AND business_id=? AND branch_id=?').run(status, current.id, tenant.businessId, tenant.branchId)
        return send(res, 200, await orderView(current.id, tenant))
      }
      if (req.method === 'POST' && u.pathname === '/api/orders') {
        const input = await body(req)
        if (!input.items?.length) return send(res, 400, { error: 'Order needs at least one item' })
        const ids = input.items.map((x: any) => x.menuItemId)
        const menu = await db.prepare(`SELECT * FROM menu_items WHERE business_id=? AND id IN (${ids.map(()=>'?').join(',')}) AND available=true`).all(tenant.businessId, ...ids)
        if (menu.length !== new Set(ids).size) return send(res, 400, { error: 'One or more items are unavailable' })
        const lines = input.items.map((x: any) => ({...menu.find((m: any) => m.id===x.menuItemId), quantity: Math.max(1, Math.trunc(x.quantity))}))
        const subtotal = lines.reduce((n: any, x: any) => n+x.price*x.quantity, 0), discount = Math.min(Math.max(0, Math.trunc(input.discount||0)), subtotal), total = subtotal-discount
        const id = randomUUID(), numRow = await db.prepare('SELECT COALESCE(MAX(order_number),1047)+1 AS n FROM orders').get()
        await db.transaction(async (tx: any) => {
          await tx.prepare('INSERT INTO orders(id,order_number,type,table_name,guests,status,subtotal,discount,tax,total,created_at,paid_at,inventory_deducted,business_id,branch_id) VALUES(?,?,?,?,?,?,?,?,0,?,NOW(),NULL,false,?,?)').run(id, Number(numRow.n), input.type||'Dine in', input.tableName||null, input.guests||1, 'OPEN', subtotal, discount, total, tenant.businessId, tenant.branchId)
          for (const x of lines) await tx.prepare('INSERT INTO order_items(order_id,menu_item_id,name,unit_price,quantity,business_id) VALUES(?,?,?,?,?,?)').run(id, x.id, x.name, x.price, x.quantity, tenant.businessId)
        })
        return send(res, 201, await orderView(id, tenant))
      }
      const submit = u.pathname.match(/^\/api\/orders\/([^/]+)\/submit$/)
      if (req.method==='POST'&&submit) {
        const order = await orderView(submit[1], tenant)
        if (!order||!['OPEN','KITCHEN_PENDING'].includes(order.status)) return send(res, 409, { error: 'Order cannot be submitted' })
        const inventory = await deductOrderInventory(db, submit[1], tenant)
        if (!inventory.ok) return send(res, inventory.status||409, { error: inventory.error, shortages: inventory.shortages||[] })
        await db.prepare("UPDATE orders SET status='KITCHEN_PENDING' WHERE id=? AND business_id=? AND branch_id=? AND status='OPEN'").run(submit[1], tenant.businessId, tenant.branchId)
        const submitted = await orderView(submit[1], tenant)
        await notifyKitchen(db, tenant, submitted)
        return send(res, 200, {...submitted, inventory})
      }
      const hold = u.pathname.match(/^\/api\/orders\/([^/]+)\/hold$/)
      if (req.method==='POST'&&hold) {
        const result = await db.prepare("UPDATE orders SET status='HELD' WHERE id=? AND business_id=? AND branch_id=? AND status='OPEN'").run(hold[1], tenant.businessId, tenant.branchId)
        return result.changes ? send(res, 200, await orderView(hold[1], tenant)) : send(res, 409, { error: 'Order cannot be held' })
      }
      const payment = u.pathname.match(/^\/api\/orders\/([^/]+)\/payments$/)
      if (req.method==='POST'&&payment) {
        const input = await body(req), order = await orderView(payment[1], tenant)
        if (!order) return send(res, 404, { error: 'Order not found' })
        if (order.paid_at||order.status==='CREDIT') return send(res, 409, { error: 'Order is already settled or assigned to credit' })
        if (!['Cash','Card','Mobile money','Credit'].includes(input.method)) return send(res, 400, { error: 'Invalid payment method' })
        if (input.method==='Credit'&&!String(input.borrowerName||'').trim()) return send(res, 400, { error: 'Customer name is required for a credit sale' })
        const inventory = await deductOrderInventory(db, order.id, tenant)
        if (!inventory.ok) return send(res, inventory.status||409, { error: inventory.error, shortages: inventory.shortages||[] })
        const pid = randomUUID()
        if (input.method==='Credit') {
          const due = new Date(String(input.dueDate||Date.now()+30*86400000))
          if (Number.isNaN(due.getTime())||due<new Date(new Date().toDateString())) return send(res, 400, { error: 'A valid future due date is required' })
          const loanId = randomUUID()
          await db.transaction(async (tx: any) => {
            await tx.prepare('INSERT INTO loans(id,borrower_name,borrower_phone,borrower_type,principal,amount_paid,due_date,status,notes,created_at,business_id,branch_id) VALUES(?,?,?,?,?,?,?,?,?,NOW(),?,?)').run(loanId, String(input.borrowerName).trim(), String(input.borrowerPhone||'').trim()||null, 'CUSTOMER', order.total, 0, due.toISOString().slice(0,10), 'ACTIVE', `Credit sale for invoice INV-${order.order_number}; order ${order.id}`, tenant.businessId, tenant.branchId)
            await tx.prepare("UPDATE orders SET status='CREDIT' WHERE id=? AND business_id=? AND branch_id=?").run(order.id, tenant.businessId, tenant.branchId)
          })
          return send(res, 201, { loanId, receiptNumber: order.order_number, order: await orderView(order.id, tenant), inventory, credit: true })
        }
        await db.transaction(async (tx: any) => {
          await tx.prepare('INSERT INTO payments(id,order_id,method,amount,status,created_at,business_id,branch_id) VALUES(?,?,?,?,?,NOW(),?,?)').run(pid, order.id, input.method, order.total, 'COMPLETED', tenant.businessId, tenant.branchId)
          await tx.prepare("UPDATE orders SET status='PAID',paid_at=NOW() WHERE id=? AND business_id=?").run(order.id, tenant.businessId)
        })
        return send(res, 201, { paymentId: pid, receiptNumber: order.order_number, order: await orderView(order.id, tenant), inventory })
      }
      if (req.method==='GET'&&u.pathname==='/api/sales') {
        const orders = await db.prepare('SELECT * FROM orders WHERE business_id=? AND branch_id=? ORDER BY created_at DESC LIMIT 50').all(tenant.businessId, tenant.branchId)
        const paid = orders.filter((x: any) => x.status==='PAID'), revenue = paid.reduce((n: any,x: any) => n+x.total, 0)
        const channels = await db.prepare('SELECT type,COUNT(*) AS count,COALESCE(SUM(total),0) AS revenue FROM orders WHERE business_id=? AND branch_id=? GROUP BY type').all(tenant.businessId, tenant.branchId)
        const days = (await db.prepare("SELECT TO_CHAR(created_at,'YYYY-MM-DD') AS day,COALESCE(SUM(CASE WHEN status='PAID' THEN total ELSE 0 END),0) AS revenue,COUNT(*) AS orders FROM orders WHERE business_id=? AND branch_id=? GROUP BY day ORDER BY day DESC LIMIT 7").all(tenant.businessId, tenant.branchId)).reverse()
        return send(res, 200, { orders, channels, days, summary: { revenue, orders: orders.length, paid: paid.length, average: paid.length?Math.round(revenue/paid.length):0 } })
      }
      if (req.method==='GET'&&u.pathname==='/api/dashboard/analytics') return send(res, 200, await businessAnalytics(db, tenant))
      if (tenant&&await operations(req, res, u, db, tenant)) return

      // ── Static frontend ──────────────────────────────────────────────────
      const reactRoot = fileURLToPath(new URL('../operations-react/dist/', import.meta.url))
      const p = u.pathname==='/'?'index.html':u.pathname.slice(1)
      let f = normalize(join(reactRoot, p))
      if (!f.startsWith(normalize(reactRoot))) { res.writeHead(404); return res.end('Not found') }
      if (!existsSync(f)) f = join(reactRoot, 'index.html')
      const ext = extname(f)
      const types: Record<string,string> = { '.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.json':'application/json','.woff2':'font/woff2' }
      const d = await readFile(f)
      res.writeHead(200, { 'content-type':`${types[ext]||'application/octet-stream'}; charset=utf-8`, 'cache-control':ext==='.html'?'no-store':'public, max-age=31536000, immutable' })
      res.end(d)
    } catch (e) {
      console.error(e)
      if (!res.headersSent) send(res, 500, { error: 'Internal server error' })
      else if (!res.writableEnded) res.end()
    }
  }).listen(port, '0.0.0.0', () => console.log(`✅ Zentro HTTP server listening on port ${port}`))

  // ── 2. Connect to DB in background (server already accepting requests) ────
  if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL not set — add it in Railway Variables')
    return
  }

  try {
    db = initDb(DATABASE_URL)
    console.log('[db] connecting to PostgreSQL...')
    await initSchema(db)
    console.log('[db] schema ready')

    // ── 3. Initialise all modules ──────────────────────────────────────────
    await initOperations(db)
    await initializeInventoryLink(db)
    await initializeProductCatalog(db)
    await initializeBusinessModules(db)
    await initializeSaasPlatform(db)
    await initializeAuth(db)
    await initializeTenantCore(db)
    await initializeWarehouses(db)
    await initializeExpenses(db)
    await initializeAccounting(db)
    await initializePlatformAdmin(db)
    await initializeReturns(db)
    await initializeNotifications(db)
    await initializePublicStorefront(db)
    await initializePublicContact(db)
    await initializeRestaurantTables(db)
    await initializeInvoices(db)
    await initializeProforma(db)
    await initializeCustomers(db)
    await initializeTenantSystem(db)
    await initializeCashBank(db)
    await initializeSupportRequests(db)
    await initializePlatformBackups(db)
    await initializeLoanReminders(db)

    // ── 4. Start background schedulers ────────────────────────────────────
    startBackupScheduler(db)
    startSubscriptionExpiryScheduler(db)
    startLoanReminderScheduler(db)

    ready = true
    console.log('✅ Zentro is fully ready')
  } catch (err) {
    console.error('❌ DB initialisation failed:', err)
    // Server keeps running — requests get 503 until fixed and redeployed
  }
}

main().catch(err => { console.error('Fatal startup error:', err); process.exit(1) })
