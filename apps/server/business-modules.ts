// @ts-nocheck
import { randomUUID } from 'node:crypto'

const body = async r => { let s = ''; for await (const c of r) s += c; return s ? JSON.parse(s) : {} }
const send = (r, s, v) => { const b = JSON.stringify(v); r.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); r.end(b) }

export async function initializeBusinessModules(db: any): Promise<void> {
  // Tables already created by schema.sql — no-op
}

export async function handleBusinessModules(req: any, res: any, u: any, db: any, tenant: any): Promise<boolean> {
  const { businessId, branchId } = tenant

  if (req.method === 'GET' && u.pathname === '/api/suppliers')
    return send(res, 200, await db.prepare(`
      SELECT s.*, COALESCE(SUM(p.total), 0) AS purchases, COUNT(p.id) AS purchase_orders
      FROM business_suppliers s
      LEFT JOIN purchase_orders p ON p.supplier_id=s.id AND p.business_id=s.business_id
      WHERE s.business_id=? GROUP BY s.id ORDER BY s.name`).all(businessId)), true

  if (req.method === 'POST' && u.pathname === '/api/suppliers') {
    const x = await body(req)
    if (!x.name) return send(res, 400, { error: 'Supplier name required' }), true
    const id = randomUUID()
    await db.prepare('INSERT INTO business_suppliers(id,name,contact,phone,email,status,created_at,business_id,category,country,payment_terms,outstanding,lead_time,quality_rating,on_time_rate) VALUES(?,?,?,?,?,?,NOW(),?,?,?,?,?,?,?,?)').run(id, x.name, x.contact || '', x.phone || '', x.email || '', x.status || 'ACTIVE', businessId, x.category || 'General', x.country || 'Rwanda', x.paymentTerms || '30 Days', Math.max(0, +x.outstanding || 0), Math.max(0, +x.leadTime || 0), Math.max(0, Math.min(5, +x.qualityRating || 0)), Math.max(0, Math.min(100, +x.onTimeRate || 0)))
    return send(res, 201, { ok: true, id }), true
  }

  if (req.method === 'GET' && u.pathname === '/api/transfers')
    return send(res, 200, await db.prepare('SELECT * FROM inventory_transfers WHERE business_id=? AND branch_id=? ORDER BY created_at DESC').all(businessId, branchId)), true

  if (req.method === 'POST' && u.pathname === '/api/transfers') {
    const x = await body(req), id = randomUUID()
    const warehouse = await db.prepare('SELECT id FROM warehouses WHERE business_id=? AND branch_id=? ORDER BY created_at LIMIT 1').get(businessId, branchId)
    await db.prepare('INSERT INTO inventory_transfers(id,reference,from_location,to_location,status,item_count,created_at,business_id,branch_id,warehouse_id) VALUES(?,?,?,?,?,?,NOW(),?,?,?)').run(id, `TR-${Date.now().toString().slice(-8)}`, x.fromLocation || 'Main Warehouse', x.toLocation || 'Shop Floor', 'PENDING', Math.max(1, +x.itemCount || 1), businessId, branchId, warehouse?.id || null)
    return send(res, 201, { id }), true
  }

  if (req.method === 'GET' && u.pathname === '/api/purchase-orders')
    return send(res, 200, await db.prepare('SELECT p.*,s.name AS supplier FROM purchase_orders p LEFT JOIN business_suppliers s ON s.id=p.supplier_id AND s.business_id=p.business_id WHERE p.business_id=? AND p.branch_id=? ORDER BY p.created_at DESC').all(businessId, branchId)), true

  if (req.method === 'POST' && u.pathname === '/api/purchase-orders') {
    const x = await body(req), id = randomUUID()
    const warehouse = await db.prepare('SELECT id FROM warehouses WHERE business_id=? AND branch_id=? ORDER BY created_at LIMIT 1').get(businessId, branchId)
    await db.prepare('INSERT INTO purchase_orders(id,po_number,supplier_id,status,total,item_count,expected_date,created_at,business_id,branch_id,warehouse_id) VALUES(?,?,?,?,?,?,?,NOW(),?,?,?)').run(id, `PO-${Date.now().toString().slice(-8)}`, x.supplierId || null, 'DRAFT', Math.trunc(+x.total || 0), Math.max(1, +x.itemCount || 1), x.expectedDate || null, businessId, branchId, warehouse?.id || null)
    return send(res, 201, { id }), true
  }

  if (req.method === 'GET' && u.pathname === '/api/settings') {
    const rows = await db.prepare('SELECT key,value FROM tenant_business_settings WHERE business_id=?').all(businessId)
    return send(res, 200, Object.fromEntries(rows.map((x: any) => [x.key, x.value]))), true
  }

  if (req.method === 'POST' && u.pathname === '/api/settings') {
    const x = await body(req)
    for (const [k, v] of Object.entries(x)) {
      await db.prepare('INSERT INTO tenant_business_settings(business_id,key,value,updated_at) VALUES(?,?,?,NOW()) ON CONFLICT(business_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at').run(businessId, k, String(v))
    }
    return send(res, 200, { ok: true }), true
  }

  return false
}
