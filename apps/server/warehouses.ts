// @ts-nocheck
import { randomUUID } from 'node:crypto'

const send = (res: any, s: number, v: any) => { const d = JSON.stringify(v); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) }); res.end(d) }
const read = async (req: any) => { let v = ''; for await (const c of req) v += c; return v ? JSON.parse(v) : {} }

export async function initializeWarehouses(db: any): Promise<void> {
  // Schema already created by schema.sql
}

export async function handleWarehouses(req: any, res: any, url: any, db: any, tenant: any): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/warehouses') {
    const warehouses = await db.prepare(`
      SELECT w.*,COALESCE(SUM(i.quantity),0) AS stock,
        COALESCE(SUM(i.quantity*i.unit_cost),0) AS value,COUNT(i.id) AS product_count
      FROM warehouses w
      LEFT JOIN ingredients i ON i.warehouse_id=w.id AND i.business_id=w.business_id
      WHERE w.business_id=? GROUP BY w.id ORDER BY w.created_at`).all(tenant.businessId)
    const transfers = await db.prepare('SELECT reference,from_location,to_location,status,item_count,created_at FROM inventory_transfers WHERE business_id=? ORDER BY created_at DESC LIMIT 6').all(tenant.businessId)
    send(res, 200, { warehouses, transfers }); return true
  }

  if (req.method === 'POST' && url.pathname === '/api/warehouses') {
    const input = await read(req), name = String(input.name || '').trim()
    const code = String(input.code || name).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-')
    if (!name || !code) { send(res, 400, { error: 'Warehouse name and code are required' }); return true }
    const id = randomUUID()
    try {
      await db.prepare('INSERT INTO warehouses(id,business_id,branch_id,name,code,status,created_at,address,manager,capacity,description) VALUES(?,?,?,?,?,?,NOW(),?,?,?,?)').run(id, tenant.businessId, tenant.branchId, name, code, input.status || 'ACTIVE', input.address || '', input.manager || '', Math.max(1, Number(input.capacity) || 1000), input.description || '')
      send(res, 201, { id }); return true
    } catch { send(res, 409, { error: 'A warehouse with this code already exists' }); return true }
  }

  return false
}
