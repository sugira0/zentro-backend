// @ts-nocheck
import { randomUUID } from 'node:crypto'
import { provisionBusinessTenant } from './tenant-core.ts'
import { createBusinessOwnerAccount, resetTemporaryPassword } from './auth.ts'

const json = async req => { let raw = ''; for await (const c of req) raw += c; return raw ? JSON.parse(raw) : {} }
const send = (res, s, v) => { const b = JSON.stringify(v); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b) }
const now = () => new Date().toISOString()

const moduleSeeds = [
  ['catalog','Products & categories','Core product catalogue'],['inventory','Inventory','Stock levels and adjustments'],
  ['warehouses','Warehouses & transfers','Multi-location inventory'],['suppliers','Suppliers & procurement','Suppliers and purchase orders'],
  ['retail_pos','Retail POS','Item-by-item checkout'],['wholesale','Wholesale sales','Bulk orders and price tiers'],
  ['customers','Customers & credit','Customer accounts and credit limits'],['loans','Loans & repayments','Business and customer loan tracking'],
  ['expenses','Expenses & accounting','Expenses, cash flow and accounting'],['imports','Imports & shipments','Containers, landed costs and customs'],
  ['reports','Reports & analytics','Operational and financial reporting'],['staff','Staff & permissions','Users, roles and permissions'],
  ['delivery','Delivery management','Dispatch and delivery tracking'],['restaurant','Restaurant operations','Menus, recipes, tables and kitchen'],
  ['notifications','Notifications','Email, SMS and operational alerts'],
]
const typeSeeds = [
  ['restaurant','Restaurant & café','Food service, table service and takeaway',['catalog','inventory','suppliers','retail_pos','customers','expenses','reports','staff','delivery','restaurant','notifications']],
  ['electronics','Electronics shop','Electronics retail, serial numbers and warranties',['catalog','inventory','warehouses','suppliers','retail_pos','customers','expenses','reports','staff','delivery','notifications']],
  ['hardware','Quincaillerie / hardware','Hardware, tools and construction supplies',['catalog','inventory','warehouses','suppliers','retail_pos','wholesale','customers','expenses','reports','staff','delivery','notifications']],
  ['stationery','Papeterie / stationery','School, office and stationery products',['catalog','inventory','suppliers','retail_pos','wholesale','customers','expenses','reports','staff','delivery']],
  ['wholesale_importer','Wholesale importer','Imports, containers, pallets and bulk distribution',['catalog','inventory','warehouses','suppliers','wholesale','customers','expenses','imports','reports','staff','delivery','notifications']],
  ['supermarket','Supermarket','Barcode retail, batches and promotions',['catalog','inventory','warehouses','suppliers','retail_pos','customers','expenses','reports','staff','delivery','notifications']],
  ['fashion','Fashion & footwear','Sizes, colours and product variants',['catalog','inventory','warehouses','suppliers','retail_pos','customers','expenses','reports','staff','delivery']],
  ['auto_parts','Auto spare parts','Vehicle parts and compatibility catalogues',['catalog','inventory','warehouses','suppliers','retail_pos','wholesale','customers','expenses','imports','reports','staff','delivery']],
  ['construction','Construction materials','Bulk materials, deliveries and customer credit',['catalog','inventory','warehouses','suppliers','wholesale','customers','loans','expenses','imports','reports','staff','delivery']],
  ['general_distribution','General distributor','Multi-warehouse reseller and distribution',['catalog','inventory','warehouses','suppliers','wholesale','customers','loans','expenses','imports','reports','staff','delivery','notifications']],
  ['garage','Garage & auto repair','Vehicle service jobs, parts stock and mechanic labour',['catalog','inventory','suppliers','retail_pos','customers','loans','expenses','reports','staff','delivery','notifications']],
  ['woodworking','Furniture & woodworking','Custom furniture, joinery and wood design workshops',['catalog','inventory','suppliers','retail_pos','customers','expenses','reports','staff','delivery','notifications']],
]

const trialDays = async (db: any) => {
  try { return Math.max(1, Number((await db.prepare("SELECT value FROM platform_settings WHERE key='defaultTrialDays'").get())?.value) || 14) } catch { return 14 }
}

export async function initializeSaasPlatform(db: any): Promise<void> {
  if (await db.prepare("SELECT 1 FROM platform_seed_state WHERE key='defaults'").get()) return

  for (const [code, name, description] of moduleSeeds) {
    await db.prepare('INSERT INTO business_modules(id,code,name,description,is_active) VALUES(?,?,?,?,true) ON CONFLICT(code) DO NOTHING').run(randomUUID(), code, name, description)
  }
  for (const [code, name, description] of typeSeeds) {
    await db.prepare('INSERT INTO business_types(id,code,name,description,is_active) VALUES(?,?,?,?,true) ON CONFLICT(code) DO NOTHING').run(randomUUID(), code, name, description)
  }
  for (const [code,,, modules] of typeSeeds) {
    const type = await db.prepare('SELECT id FROM business_types WHERE code=?').get(code)
    for (const moduleCode of modules) {
      const mod = await db.prepare('SELECT id FROM business_modules WHERE code=?').get(moduleCode)
      if (type && mod) await db.prepare('INSERT INTO business_type_modules(business_type_id,module_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(type.id, mod.id)
    }
  }
  for (const [code, name, price, branches, users] of [['starter','Starter',25000,1,5],['growth','Growth',65000,3,20],['enterprise','Enterprise',150000,99,999]]) {
    await db.prepare('INSERT INTO subscription_plans(id,code,name,monthly_price,branch_limit,user_limit,is_active) VALUES(?,?,?,?,?,?,true) ON CONFLICT(code) DO NOTHING').run(randomUUID(), code, name, price, branches, users)
  }
  await db.prepare('INSERT INTO platform_seed_state(key,seeded_at) VALUES(?,NOW()) ON CONFLICT(key) DO NOTHING').run('defaults')
}

const businessList = async (db: any) => db.prepare(`
  SELECT b.*,t.code AS type_code,t.name AS type_name,p.id AS plan_id,p.name AS plan_name,
    s.status AS subscription_status,
    (SELECT COUNT(*) FROM business_module_assignments a WHERE a.business_id=b.id AND a.enabled=true) AS module_count,
    (SELECT COUNT(*) FROM business_users bu WHERE bu.business_id=b.id AND bu.status='ACTIVE') AS user_count,
    COALESCE((SELECT SUM(sp.amount) FROM subscription_payments sp JOIN subscriptions sx ON sx.id=sp.subscription_id WHERE sx.business_id=b.id AND sp.status IN ('SUCCESS','COMPLETED','PAID') AND sp.created_at>=DATE_TRUNC('month',NOW())),0) AS monthly_revenue
  FROM businesses b JOIN business_types t ON t.id=b.business_type_id
  LEFT JOIN subscriptions s ON s.id=(SELECT id FROM subscriptions WHERE business_id=b.id ORDER BY starts_at DESC LIMIT 1)
  LEFT JOIN subscription_plans p ON p.id=s.plan_id
  ORDER BY b.created_at DESC`).all()

export async function handleSaasPlatform(req: any, res: any, url: any, db: any): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/platform/summary') {
    const businesses = await businessList(db)
    const mrr = await db.prepare("SELECT COALESCE(SUM(p.monthly_price),0) AS value FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.status='ACTIVE'").get()
    return send(res, 200, { businesses: businesses.length, active: businesses.filter(x=>x.status==='ACTIVE').length, trials: businesses.filter(x=>x.status==='TRIAL').length, suspended: businesses.filter(x=>x.status==='SUSPENDED').length, monthlyRevenue: mrr.value }), true
  }

  if (req.method === 'GET' && url.pathname === '/api/platform/business-types')
    return send(res, 200, await db.prepare(`
      SELECT t.*,COUNT(DISTINCT tm.module_id) AS module_count,COUNT(DISTINCT b.id) AS business_count,
        STRING_AGG(DISTINCT m.id,',') AS module_ids,STRING_AGG(DISTINCT m.name,',') AS module_names
      FROM business_types t
      LEFT JOIN business_type_modules tm ON tm.business_type_id=t.id
      LEFT JOIN business_modules m ON m.id=tm.module_id
      LEFT JOIN businesses b ON b.business_type_id=t.id
      GROUP BY t.id ORDER BY t.is_active DESC,t.name`).all()), true

  if (req.method === 'GET' && url.pathname === '/api/platform/modules')
    return send(res, 200, await db.prepare('SELECT * FROM business_modules ORDER BY is_active DESC,name').all()), true

  if (req.method === 'GET' && url.pathname === '/api/platform/plans')
    return send(res, 200, await db.prepare(`
      SELECT p.*,COUNT(s.id) AS business_count,
        COALESCE(SUM(CASE WHEN s.status='ACTIVE' THEN p.monthly_price ELSE 0 END),0) AS recurring_revenue,
        'MONTHLY' AS billing_cycle
      FROM subscription_plans p LEFT JOIN subscriptions s ON s.plan_id=p.id
      GROUP BY p.id ORDER BY p.is_active DESC,p.monthly_price`).all()), true

  if (req.method === 'GET' && url.pathname === '/api/platform/businesses')
    return send(res, 200, await businessList(db)), true

  if (req.method === 'POST' && url.pathname === '/api/platform/businesses') {
    const x = await json(req)
    const name = String(x.name || '').trim()
    const slug = String(x.slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const type = await db.prepare('SELECT * FROM business_types WHERE id=? OR code=?').get(x.businessTypeId, x.businessTypeId)
    const plan = await db.prepare('SELECT * FROM subscription_plans WHERE id=? OR code=?').get(x.planId || 'starter', x.planId || 'starter')
    if (!name || !slug || !type || !plan || !x.ownerName || !x.ownerEmail) return send(res, 400, { error: 'Business name, type, plan, owner name and email are required' }), true
    if (x.temporaryPassword && String(x.temporaryPassword).length < 10) return send(res, 400, { error: 'Temporary password must contain at least 10 characters' }), true
    const id = randomUUID()
    const days = await trialDays(db)
    const trialEndsAt = x.status === 'ACTIVE' ? null : new Date(Date.now() + days * 86400000).toISOString()
    try {
      await db.transaction(async tx => {
        await tx.prepare('INSERT INTO businesses(id,name,slug,business_type_id,owner_name,owner_email,owner_phone,status,currency,country,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,NOW())').run(id, name, slug, type.id, x.ownerName, x.ownerEmail, x.ownerPhone || '', x.status || 'TRIAL', x.currency || 'RWF', x.country || 'Rwanda')
        await tx.prepare('INSERT INTO subscriptions(id,business_id,plan_id,status,starts_at,ends_at) VALUES(?,?,?,?,NOW(),?)').run(randomUUID(), id, plan.id, x.status === 'ACTIVE' ? 'ACTIVE' : 'TRIAL', trialEndsAt)
        await tx.prepare('INSERT INTO business_module_assignments(business_id,module_id,enabled,assigned_at) SELECT ?,module_id,true,NOW() FROM business_type_modules WHERE business_type_id=? ON CONFLICT DO NOTHING').run(id, type.id)
      })
      const tenant = await provisionBusinessTenant(db, id, type.code)
      const account = await createBusinessOwnerAccount(db, { businessId: id, name: x.ownerName, email: x.ownerEmail, phone: x.ownerPhone, password: x.temporaryPassword, branchId: tenant.branchId })
      await db.prepare('INSERT INTO platform_audit_logs(id,actor,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,?,?,?,NOW())').run(randomUUID(), 'local-superadmin', 'CREATE_BUSINESS', 'business', id, JSON.stringify({ name, slug, type: type.code }))
      return send(res, 201, { id, slug, ownerEmail: String(x.ownerEmail).toLowerCase(), temporaryPassword: account.temporaryPassword, branchId: tenant.branchId, warehouseId: tenant.warehouseId }), true
    } catch (error: any) {
      return send(res, 409, { error: error.message || 'Business slug or account already exists' }), true
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/platform/business-types') {
    const x = await json(req), name = String(x.name || '').trim(), code = String(x.code || name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    if (!name || !code) return send(res, 400, { error: 'Name and code are required' }), true
    try {
      const id = randomUUID()
      await db.prepare('INSERT INTO business_types(id,code,name,description,is_active) VALUES(?,?,?,?,true)').run(id, code, name, x.description || '')
      for (const moduleId of x.moduleIds || []) await db.prepare('INSERT INTO business_type_modules(business_type_id,module_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(id, moduleId)
      return send(res, 201, { id }), true
    } catch { return send(res, 409, { error: 'Business type code already exists' }), true }
  }

  if (req.method === 'POST' && url.pathname === '/api/platform/modules') {
    const x = await json(req), name = String(x.name || '').trim(), code = String(x.code || name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    if (!name || !code) return send(res, 400, { error: 'Name and code are required' }), true
    try {
      const id = randomUUID(); await db.prepare('INSERT INTO business_modules(id,code,name,description,is_active) VALUES(?,?,?,?,true)').run(id, code, name, x.description || '')
      return send(res, 201, { id }), true
    } catch { return send(res, 409, { error: 'Module code already exists' }), true }
  }

  if (req.method === 'POST' && url.pathname === '/api/platform/plans') {
    const x = await json(req), name = String(x.name || '').trim(), code = String(x.code || name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    if (!name || !code || Number(x.monthlyPrice) < 0) return send(res, 400, { error: 'Name, code and valid price are required' }), true
    try {
      const id = randomUUID(); await db.prepare('INSERT INTO subscription_plans(id,code,name,monthly_price,branch_limit,user_limit,is_active) VALUES(?,?,?,?,?,?,true)').run(id, code, name, Math.trunc(Number(x.monthlyPrice)), Math.max(1, Number(x.branchLimit) || 1), Math.max(1, Number(x.userLimit) || 1))
      return send(res, 201, { id }), true
    } catch { return send(res, 409, { error: 'Plan code already exists' }), true }
  }

  const item = url.pathname.match(/^\/api\/platform\/businesses\/([^/]+)$/)
  if (item && req.method === 'PATCH') {
    const x = await json(req), current = await db.prepare('SELECT * FROM businesses WHERE id=?').get(item[1])
    if (!current) return send(res, 404, { error: 'Business not found' }), true
    const status = x.status ?? current.status
    await db.prepare('UPDATE businesses SET name=?,status=?,currency=?,country=? WHERE id=?').run(x.name ?? current.name, status, x.currency ?? current.currency, x.country ?? current.country, current.id)
    if (x.status && ['ACTIVE','TRIAL','SUSPENDED'].includes(status)) {
      const sub = await db.prepare('SELECT * FROM subscriptions WHERE business_id=? ORDER BY starts_at DESC LIMIT 1').get(current.id)
      if (sub) {
        const clearStaleEnd = status === 'ACTIVE' && sub.ends_at && new Date(sub.ends_at) < new Date()
        await db.prepare('UPDATE subscriptions SET status=?,ends_at=? WHERE id=?').run(status, clearStaleEnd ? null : sub.ends_at, sub.id)
      }
    }
    return send(res, 200, { ok: true }), true
  }

  const ownerPassword = url.pathname.match(/^\/api\/platform\/businesses\/([^/]+)\/reset-owner-password$/)
  if (ownerPassword && req.method === 'POST') {
    const x = await json(req), business = await db.prepare('SELECT * FROM businesses WHERE id=?').get(ownerPassword[1])
    if (!business) return send(res, 404, { error: 'Business not found' }), true
    const owner = await db.prepare(`SELECT u.id FROM users u JOIN business_users bu ON bu.user_id=u.id JOIN roles r ON r.id=bu.role_id WHERE bu.business_id=? AND r.code='BUSINESS_OWNER' ORDER BY bu.created_at LIMIT 1`).get(business.id)
    if (!owner) return send(res, 404, { error: 'Business owner account not found' }), true
    try {
      const result = await resetTemporaryPassword(db, owner.id, x.temporaryPassword)
      await db.prepare('INSERT INTO platform_audit_logs(id,actor,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,?,?,?,NOW())').run(randomUUID(), 'local-superadmin', 'RESET_OWNER_PASSWORD', 'business', business.id, JSON.stringify({ ownerEmail: result.email }))
      return send(res, 200, result), true
    } catch (error: any) { return send(res, 400, { error: error.message }), true }
  }

  const typeItem = url.pathname.match(/^\/api\/platform\/business-types\/([^/]+)$/)
  if (typeItem && req.method === 'PATCH') {
    const x = await json(req), current = await db.prepare('SELECT * FROM business_types WHERE id=?').get(typeItem[1])
    if (!current) return send(res, 404, { error: 'Business type not found' }), true
    await db.prepare('UPDATE business_types SET name=?,description=?,is_active=? WHERE id=?').run(x.name ?? current.name, x.description ?? current.description, x.isActive === undefined ? current.is_active : Boolean(x.isActive), current.id)
    if (Array.isArray(x.moduleIds)) {
      await db.prepare('DELETE FROM business_type_modules WHERE business_type_id=?').run(current.id)
      for (const id of x.moduleIds) await db.prepare('INSERT INTO business_type_modules(business_type_id,module_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(current.id, id)
    }
    return send(res, 200, { ok: true }), true
  }

  const moduleItem = url.pathname.match(/^\/api\/platform\/modules\/([^/]+)$/)
  if (moduleItem && req.method === 'PATCH') {
    const x = await json(req), current = await db.prepare('SELECT * FROM business_modules WHERE id=?').get(moduleItem[1])
    if (!current) return send(res, 404, { error: 'Module not found' }), true
    await db.prepare('UPDATE business_modules SET name=?,description=?,is_active=? WHERE id=?').run(x.name ?? current.name, x.description ?? current.description, x.isActive === undefined ? current.is_active : Boolean(x.isActive), current.id)
    return send(res, 200, { ok: true }), true
  }

  const planItem = url.pathname.match(/^\/api\/platform\/plans\/([^/]+)$/)
  if (planItem && req.method === 'PATCH') {
    const x = await json(req), current = await db.prepare('SELECT * FROM subscription_plans WHERE id=?').get(planItem[1])
    if (!current) return send(res, 404, { error: 'Plan not found' }), true
    await db.prepare('UPDATE subscription_plans SET name=?,monthly_price=?,branch_limit=?,user_limit=?,is_active=? WHERE id=?').run(x.name ?? current.name, x.monthlyPrice === undefined ? current.monthly_price : Math.max(0, Math.trunc(Number(x.monthlyPrice))), x.branchLimit === undefined ? current.branch_limit : Math.max(1, Math.trunc(Number(x.branchLimit))), x.userLimit === undefined ? current.user_limit : Math.max(1, Math.trunc(Number(x.userLimit))), x.isActive === undefined ? current.is_active : Boolean(x.isActive), current.id)
    return send(res, 200, { ok: true }), true
  }

  const modules = url.pathname.match(/^\/api\/platform\/businesses\/([^/]+)\/modules$/)
  if (modules && req.method === 'GET')
    return send(res, 200, await db.prepare('SELECT m.*,COALESCE(a.enabled,false) AS enabled FROM business_modules m LEFT JOIN business_module_assignments a ON a.module_id=m.id AND a.business_id=? ORDER BY m.name').all(modules[1])), true

  if (modules && req.method === 'POST') {
    const x = await json(req), enabled = new Set(x.moduleIds || [])
    const rows = await db.prepare('SELECT id FROM business_modules').all()
    for (const row of rows) await db.prepare('INSERT INTO business_module_assignments(business_id,module_id,enabled,assigned_at) VALUES(?,?,?,NOW()) ON CONFLICT(business_id,module_id) DO UPDATE SET enabled=EXCLUDED.enabled,assigned_at=EXCLUDED.assigned_at').run(modules[1], row.id, enabled.has(row.id))
    return send(res, 200, { ok: true }), true
  }

  return false
}
