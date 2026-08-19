// @ts-nocheck
import { randomUUID } from 'node:crypto'

const send = (r: any, s: number, v: any) => { const b = JSON.stringify(v); r.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); r.end(b) }
const read = async (r: any) => { let b = ''; for await (const c of r) b += c; return b ? JSON.parse(b) : {} }

export async function initializeCustomers(db: any): Promise<void> {
  // Schema already created by schema.sql
}

async function list(db: any, t: any): Promise<any> {
  const items = await db.prepare(`
    SELECT c.*,COUNT(i.id) AS total_orders,COALESCE(SUM(i.total),0) AS total_value,
      COALESCE(SUM(i.total-i.paid),0) AS outstanding_balance,COALESCE(AVG(i.total),0) AS average_order_value
    FROM customers c
    LEFT JOIN invoices i ON lower(i.customer_name)=lower(c.name) AND i.business_id=c.business_id AND i.branch_id=c.branch_id
    WHERE c.business_id=? AND c.branch_id=?
    GROUP BY c.id ORDER BY total_value DESC,c.name`).all(t.businessId, t.branchId)
  const active = items.filter((x: any) => x.status === 'ACTIVE')
  const totalReceivables = items.reduce((n: number, x: any) => n + x.outstanding_balance, 0)
  const totalValue = items.reduce((n: number, x: any) => n + x.total_value, 0)
  const groups = await db.prepare(`SELECT COALESCE(group_name,'Retail') AS name,COUNT(*) AS count FROM customers WHERE business_id=? AND branch_id=? GROUP BY group_name ORDER BY count DESC`).all(t.businessId, t.branchId)
  return { items, summary: { total: items.length, active: active.length, inactive: items.length - active.length, totalReceivables, averageOrderValue: items.reduce((n: number, x: any) => n + x.total_orders, 0) ? Math.round(totalValue / items.reduce((n: number, x: any) => n + x.total_orders, 0)) : 0 }, topCustomers: items.slice(0, 5), groups }
}

export async function handleCustomers(req: any, res: any, url: any, db: any, t: any): Promise<boolean> {
  const p = url.pathname
  if (req.method === 'GET' && p === '/api/customers') return send(res, 200, await list(db, t)), true

  if (req.method === 'POST' && p === '/api/customers') {
    const x = await read(req), name = String(x.name || '').trim(), phone = String(x.phone || '').trim()
    const customerType = String(x.customerType || 'INDIVIDUAL').toUpperCase(), tin = String(x.tin || '').trim()
    if (!['INDIVIDUAL', 'CORPORATE'].includes(customerType)) return send(res, 400, { error: 'Customer type must be Individual or Corporate' }), true
    if (!name) return send(res, 400, { error: customerType === 'CORPORATE' ? 'Business name is required' : 'Customer name is required' }), true
    if (!phone) return send(res, 400, { error: 'Phone number is required' }), true
    if (customerType === 'CORPORATE' && !tin) return send(res, 400, { error: 'TIN number is required for corporate customers' }), true
    const id = randomUUID()
    await db.prepare('INSERT INTO customers(id,business_id,branch_id,name,phone,email,status,created_at,company,group_name,location,updated_at,customer_type,tin) VALUES(?,?,?,?,?,?,?,NOW(),?,?,?,NOW(),?,?)').run(id, t.businessId, t.branchId, name, phone, String(x.email || ''), x.status || 'ACTIVE', String(x.company || ''), x.groupName || (customerType === 'CORPORATE' ? 'Corporate' : 'Retail'), String(x.location || ''), customerType, customerType === 'CORPORATE' ? tin : null)
    return send(res, 201, { id }), true
  }

  const m = p.match(/^\/api\/customers\/([^/]+)$/)
  if (req.method === 'GET' && m) {
    const customer = await db.prepare('SELECT * FROM customers WHERE id=? AND business_id=? AND branch_id=?').get(m[1], t.businessId, t.branchId)
    if (!customer) return send(res, 404, { error: 'Customer not found' }), true
    const invoices = await db.prepare('SELECT * FROM invoices WHERE business_id=? AND branch_id=? AND lower(customer_name)=lower(?) ORDER BY issued_at DESC').all(t.businessId, t.branchId, customer.name)
    return send(res, 200, { ...customer, invoices }), true
  }

  if (req.method === 'PATCH' && m) {
    const x = await read(req), old = await db.prepare('SELECT * FROM customers WHERE id=? AND business_id=? AND branch_id=?').get(m[1], t.businessId, t.branchId)
    if (!old) return send(res, 404, { error: 'Customer not found' }), true
    const customerType = String(x.customerType ?? old.customer_type ?? 'INDIVIDUAL').toUpperCase()
    const phone = String(x.phone ?? old.phone ?? '').trim(), tin = String(x.tin ?? old.tin ?? '').trim()
    if (!phone) return send(res, 400, { error: 'Phone number is required' }), true
    if (customerType === 'CORPORATE' && !tin) return send(res, 400, { error: 'TIN number is required for corporate customers' }), true
    await db.prepare('UPDATE customers SET name=?,phone=?,email=?,company=?,group_name=?,location=?,status=?,updated_at=NOW(),customer_type=?,tin=? WHERE id=? AND business_id=?').run(x.name ?? old.name, phone, x.email ?? old.email, x.company ?? old.company, x.groupName ?? old.group_name, x.location ?? old.location, x.status ?? old.status, customerType, customerType === 'CORPORATE' ? tin : null, old.id, t.businessId)
    return send(res, 200, { ok: true }), true
  }

  return false
}
