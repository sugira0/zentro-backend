// @ts-nocheck
import { randomUUID } from 'node:crypto'

const send = (res: any, s: number, v: any) => { const t = JSON.stringify(v); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(t) }); res.end(t) }
const read = async (req: any) => { let r = ''; for await (const c of req) r += c; return r ? JSON.parse(r) : {} }
const clean = (v: any) => String(v || '').trim()

export async function initializeRestaurantTables(db: any): Promise<void> {
  // Schema already created by schema.sql
}

async function list(db: any, t: any): Promise<any[]> {
  return db.prepare(`
    SELECT rt.*,o.id AS active_order_id,o.order_number,o.status AS order_status,o.total AS order_total,o.guests,o.created_at AS order_created_at,
      p.customer_name,p.customer_phone,p.notes,
      COALESCE((SELECT SUM(oi.quantity) FROM order_items oi WHERE oi.order_id=o.id),0) AS item_count
    FROM restaurant_tables rt
    LEFT JOIN orders o ON o.id=(
      SELECT x.id FROM orders x WHERE x.business_id=rt.business_id AND x.branch_id=rt.branch_id
        AND x.type='Dine in' AND lower(x.table_name)=lower(rt.code)
        AND x.status NOT IN ('PAID','CREDIT','CANCELLED','DELIVERED') ORDER BY x.created_at DESC LIMIT 1)
    LEFT JOIN public_order_details p ON p.order_id=o.id
    WHERE rt.business_id=? AND rt.branch_id=? ORDER BY rt.area,rt.name`).all(t.businessId, t.branchId)
}

export async function handleRestaurantTables(req: any, res: any, url: any, db: any, t: any): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/tables') {
    const items = await list(db, t)
    const business = await db.prepare('SELECT slug,name FROM businesses WHERE id=?').get(t.businessId)
    return send(res, 200, { items, restaurant: business, summary: { total: items.length, occupied: items.filter((x: any) => x.active_order_id).length, available: items.filter((x: any) => !x.active_order_id && x.status === 'AVAILABLE').length, reserved: items.filter((x: any) => x.status === 'RESERVED').length } }), true
  }

  if (req.method === 'POST' && url.pathname === '/api/tables') {
    const x = await read(req), name = clean(x.name), code = clean(x.code || name).replace(/\s+/g, '-').toUpperCase()
    const capacity = Math.max(1, Math.min(30, Math.trunc(Number(x.capacity) || 2)))
    if (!name || !code) return send(res, 400, { error: 'Table name and code are required' }), true
    try {
      const id = randomUUID()
      await db.prepare('INSERT INTO restaurant_tables(id,business_id,branch_id,name,code,area,capacity,status,created_at) VALUES(?,?,?,?,?,?,?,?,NOW())').run(id, t.businessId, t.branchId, name, code, clean(x.area) || 'Main Dining', capacity, 'AVAILABLE')
      return send(res, 201, { id, items: await list(db, t) }), true
    } catch { return send(res, 409, { error: 'A table with this code already exists' }), true }
  }

  const item = url.pathname.match(/^\/api\/tables\/([^/]+)$/)
  if (item && req.method === 'PATCH') {
    const x = await read(req), current = await db.prepare('SELECT * FROM restaurant_tables WHERE id=? AND business_id=? AND branch_id=?').get(item[1], t.businessId, t.branchId)
    if (!current) return send(res, 404, { error: 'Table not found' }), true
    const status = ['AVAILABLE', 'RESERVED', 'OUT_OF_SERVICE'].includes(x.status) ? x.status : current.status
    await db.prepare('UPDATE restaurant_tables SET name=?,code=?,area=?,capacity=?,status=? WHERE id=?').run(clean(x.name) || current.name, (clean(x.code) || current.code).replace(/\s+/g, '-').toUpperCase(), clean(x.area) || current.area, Math.max(1, Math.min(30, Math.trunc(Number(x.capacity) || current.capacity))), status, current.id)
    return send(res, 200, { ok: true }), true
  }

  if (item && req.method === 'DELETE') {
    const table = await db.prepare('SELECT * FROM restaurant_tables WHERE id=? AND business_id=? AND branch_id=?').get(item[1], t.businessId, t.branchId)
    if (!table) return send(res, 404, { error: 'Table not found' }), true
    const active = await db.prepare("SELECT 1 FROM orders WHERE business_id=? AND branch_id=? AND type='Dine in' AND lower(table_name)=lower(?) AND status NOT IN ('PAID','CREDIT','CANCELLED','DELIVERED')").get(t.businessId, t.branchId, table.code)
    if (active) return send(res, 409, { error: 'This table has an active order' }), true
    await db.prepare('DELETE FROM restaurant_tables WHERE id=?').run(table.id)
    return send(res, 200, { ok: true }), true
  }

  return false
}
