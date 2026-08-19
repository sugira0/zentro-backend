// @ts-nocheck
import { randomUUID } from 'node:crypto'
import { deductOrderInventory } from './inventory-link.ts'
import { notifyKitchen } from './notifications.ts'

const send = (res: any, s: number, v: any) => { const t = JSON.stringify(v); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(t) }); res.end(t) }
const read = async (req: any) => { let r = ''; for await (const c of req) r += c; return r ? JSON.parse(r) : {} }

export async function initializePublicStorefront(db: any): Promise<void> {
  // Schema already created by schema.sql
}

export async function handlePublicStorefront(req: any, res: any, url: any, db: any): Promise<boolean> {
  const route = url.pathname.match(/^\/api\/public\/restaurants\/([^/]+)(?:\/(orders))?$/)
  if (!route) return false

  const slug = decodeURIComponent(route[1])
  const business = await db.prepare(`SELECT b.id,b.name,b.slug,b.currency,b.owner_phone AS phone,bt.code AS type FROM businesses b JOIN business_types bt ON bt.id=b.business_type_id WHERE b.slug=? AND b.status IN ('ACTIVE','TRIAL')`).get(slug)
  if (!business || business.type !== 'restaurant') return send(res, 404, { error: 'Restaurant not found' }), true

  const branch = await db.prepare(`SELECT id,name,address FROM branches WHERE business_id=? AND status='ACTIVE' ORDER BY created_at LIMIT 1`).get(business.id)
  if (!branch) return send(res, 409, { error: 'Restaurant is not accepting online orders' }), true

  if (req.method === 'GET' && !route[2]) {
    const items = await db.prepare(`SELECT id,name,category,price,image,description,menu_kind AS "menuKind",dietary_tag AS "dietaryTag",preparation_time AS "preparationTime" FROM menu_items WHERE business_id=? AND available=true AND product_status='ACTIVE' ORDER BY favorite DESC,category,name`).all(business.id)
    const categories = await db.prepare(`SELECT key,name,description FROM categories WHERE business_id=? AND is_active=true ORDER BY name`).all(business.id)
    return send(res, 200, { restaurant: { name: business.name, slug: business.slug, currency: business.currency, phone: business.phone, branch: branch.name, address: branch.address }, categories, items }), true
  }

  if (req.method === 'POST' && route[2]) {
    const x = await read(req), name = String(x.customerName || '').trim(), phone = String(x.customerPhone || '').trim()
    const fulfillment = String(x.fulfillment || 'Pickup'), tableName = String(x.tableName || '').trim()
    if (!name || !phone || !Array.isArray(x.items) || !x.items.length || !['Pickup', 'Delivery', 'Dine in'].includes(fulfillment))
      return send(res, 400, { error: 'Name, phone, fulfillment method and order items are required' }), true
    if (fulfillment === 'Delivery' && !String(x.address || '').trim()) return send(res, 400, { error: 'Delivery address is required' }), true
    if (fulfillment === 'Dine in' && !tableName) return send(res, 400, { error: 'Table number is required for dine-in orders' }), true

    const ids = x.items.map((i: any) => Number(i.menuItemId)).filter(Number.isFinite)
    const menu = ids.length ? await db.prepare(`SELECT * FROM menu_items WHERE business_id=? AND available=true AND product_status='ACTIVE' AND id IN (${ids.map(() => '?').join(',')})`).all(business.id, ...ids) : []
    if (menu.length !== new Set(ids).size) return send(res, 400, { error: 'One or more selected items are unavailable' }), true

    const lines = x.items.map((i: any) => ({ ...menu.find((m: any) => m.id === Number(i.menuItemId)), quantity: Math.min(99, Math.max(1, Math.trunc(Number(i.quantity) || 1))) }))
    const subtotal = lines.reduce((s: number, i: any) => s + i.price * i.quantity, 0)
    const id = randomUUID()
    const numRow = await db.prepare('SELECT COALESCE(MAX(order_number),1047)+1 AS n FROM orders').get()
    const number = Number(numRow.n)
    const tenant = { businessId: business.id, branchId: branch.id, userId: 'public-storefront', role: 'CUSTOMER' }

    await db.transaction(async (tx: any) => {
      await tx.prepare('INSERT INTO orders(id,order_number,type,table_name,guests,status,subtotal,discount,tax,total,created_at,paid_at,inventory_deducted,business_id,branch_id) VALUES(?,?,?,?,?,?,?,?,0,?,NOW(),NULL,false,?,?)').run(id, number, fulfillment, fulfillment === 'Dine in' ? tableName : null, Math.max(1, Math.trunc(Number(x.guests) || 1)), 'OPEN', subtotal, 0, subtotal, business.id, branch.id)
      for (const item of lines) await tx.prepare('INSERT INTO order_items(order_id,menu_item_id,name,unit_price,quantity,business_id) VALUES(?,?,?,?,?,?)').run(id, item.id, item.name, item.price, item.quantity, business.id)
      await tx.prepare('INSERT INTO public_order_details(order_id,business_id,branch_id,customer_name,customer_phone,customer_email,address,notes,fulfillment,created_at) VALUES(?,?,?,?,?,?,?,?,?,NOW())').run(id, business.id, branch.id, name, phone, String(x.customerEmail || '').trim() || null, String(x.address || '').trim() || null, String(x.notes || '').trim() || null, fulfillment)
    })

    const inventory = await deductOrderInventory(db, id, tenant)
    if (!inventory.ok) {
      await db.transaction(async (tx: any) => {
        await tx.prepare('DELETE FROM public_order_details WHERE order_id=?').run(id)
        await tx.prepare('DELETE FROM order_items WHERE order_id=?').run(id)
        await tx.prepare('DELETE FROM orders WHERE id=?').run(id)
      })
      return send(res, inventory.status || 409, { error: inventory.error || 'Some items are unavailable', shortages: inventory.shortages || [] }), true
    }

    await db.prepare("UPDATE orders SET status='KITCHEN_PENDING' WHERE id=?").run(id)
    const order = { id, order_number: number, type: fulfillment === 'Dine in' ? `Dine in · Table ${tableName}` : fulfillment, total: subtotal, items: lines.map((i: any) => ({ name: i.name, quantity: i.quantity, unitPrice: i.price })) }
    await notifyKitchen(db, tenant, order)
    return send(res, 201, { orderNumber: number, total: subtotal, status: 'KITCHEN_PENDING', tableName: fulfillment === 'Dine in' ? tableName : null, message: 'Your order has been sent to the kitchen' }), true
  }

  return send(res, 405, { error: 'Method not allowed' }), true
}
