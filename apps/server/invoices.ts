// @ts-nocheck
import { randomUUID } from 'node:crypto'

const send = (res: any, s: number, v: any) => { const b = JSON.stringify(v); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b) }
const json = async (req: any) => { let r = ''; for await (const c of req) r += c; return r ? JSON.parse(r) : {} }
const view = (row: any) => { const paid = Number(row.paid || 0), total = Number(row.total || 0), overdue = paid < total && new Date(row.due_at) < new Date(new Date().toDateString()), status = paid >= total ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : overdue ? 'OVERDUE' : 'UNPAID'; return { ...row, paid, total, balance: Math.max(0, total - paid), status } }

export async function initializeInvoices(db: any): Promise<void> {
  // Schema already created by schema.sql
}

async function syncOrders(db: any, t: any): Promise<void> {
  const orders = await db.prepare(`SELECT o.*,COALESCE(SUM(CASE WHEN p.status='COMPLETED' THEN p.amount ELSE 0 END),0) AS paid FROM orders o LEFT JOIN payments p ON p.order_id=o.id AND p.business_id=o.business_id WHERE o.business_id=? AND o.branch_id=? GROUP BY o.id`).all(t.businessId, t.branchId)
  for (const o of orders) {
    const id = `invoice-${o.id}`, due = new Date(new Date(o.created_at).getTime() + 7 * 86400000).toISOString()
    await db.prepare("INSERT INTO invoices(id,invoice_number,business_id,branch_id,source_order_id,customer_name,issued_at,due_at,total,paid,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(business_id,invoice_number) DO NOTHING").run(id, `INV-${o.order_number}`, t.businessId, t.branchId, o.id, o.table_name || o.type || 'Walk-in customer', o.created_at, due, o.total, o.paid, o.created_at)
    const items = await db.prepare('SELECT * FROM order_items WHERE order_id=? AND business_id=?').all(o.id, t.businessId)
    for (const line of items) await db.prepare("INSERT INTO invoice_items(id,invoice_id,business_id,name,quantity,unit_price) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING").run(`invoice-item-${line.id}`, id, t.businessId, line.name, line.quantity, line.unit_price)
  }
}

async function list(db: any, t: any): Promise<any> {
  await syncOrders(db, t)
  const items = (await db.prepare('SELECT * FROM invoices WHERE business_id=? AND branch_id=? ORDER BY issued_at DESC').all(t.businessId, t.branchId)).map(view)
  const summary = { all: items.length, totalValue: items.reduce((n: number, x: any) => n + x.total, 0), paid: items.filter((x: any) => x.status === 'PAID').length, paidValue: items.reduce((n: number, x: any) => n + x.paid, 0), partial: items.filter((x: any) => x.status === 'PARTIALLY_PAID').length, partialValue: items.filter((x: any) => x.status === 'PARTIALLY_PAID').reduce((n: number, x: any) => n + x.balance, 0), unpaid: items.filter((x: any) => x.status === 'UNPAID').length, unpaidValue: items.filter((x: any) => x.status === 'UNPAID').reduce((n: number, x: any) => n + x.balance, 0), overdue: items.filter((x: any) => x.status === 'OVERDUE').length, overdueValue: items.filter((x: any) => x.status === 'OVERDUE').reduce((n: number, x: any) => n + x.balance, 0) }
  const topCustomers = await db.prepare('SELECT customer_name AS name,SUM(total) AS value FROM invoices WHERE business_id=? AND branch_id=? GROUP BY customer_name ORDER BY value DESC LIMIT 5').all(t.businessId, t.branchId)
  const activities = await db.prepare(`SELECT p.id,'PAYMENT' AS type,'Payment recorded for '||i.invoice_number AS title,p.amount,p.created_at AS "createdAt" FROM invoice_payments p JOIN invoices i ON i.id=p.invoice_id WHERE p.business_id=? AND p.branch_id=? UNION ALL SELECT id,'INVOICE','Invoice '||invoice_number||' generated',total,created_at FROM invoices WHERE business_id=? AND branch_id=? ORDER BY "createdAt" DESC LIMIT 6`).all(t.businessId, t.branchId, t.businessId, t.branchId)
  const trend = await db.prepare("SELECT TO_CHAR(issued_at,'YYYY-MM-DD') AS day,SUM(total) AS value FROM invoices WHERE business_id=? AND branch_id=? AND issued_at>=NOW()-INTERVAL '30 days' GROUP BY day ORDER BY day").all(t.businessId, t.branchId)
  return { items, summary, topCustomers, activities, trend }
}

export async function handleInvoices(req: any, res: any, url: any, db: any, t: any): Promise<boolean> {
  const path = url.pathname
  if (req.method === 'GET' && path === '/api/invoices') return send(res, 200, await list(db, t)), true

  if (req.method === 'POST' && path === '/api/invoices') {
    const x = await json(req), customer = String(x.customerName || '').trim(), lines = Array.isArray(x.items) ? x.items : []
    if (!customer || !lines.length) return send(res, 400, { error: 'Customer and at least one item are required' }), true
    const normalized = lines.map((line: any) => ({ name: String(line.name), quantity: Math.max(1, Number(line.quantity) || 1), unitPrice: Math.max(0, Math.trunc(Number(line.unitPrice) || 0)) }))
    const total = normalized.reduce((n: number, line: any) => n + line.quantity * line.unitPrice, 0)
    const id = randomUUID()
    const countRow = await db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE business_id=?').get(t.businessId)
    const number = `INV-${new Date().getFullYear()}-${String(countRow.n + 1).padStart(5, '0')}`
    const due = new Date(String(x.dueAt || Date.now() + 14 * 86400000))
    if (Number.isNaN(due.getTime())) return send(res, 400, { error: 'Valid due date required' }), true
    await db.transaction(async (tx: any) => {
      await tx.prepare('INSERT INTO invoices(id,invoice_number,business_id,branch_id,source_order_id,customer_name,customer_email,issued_at,due_at,total,paid,notes,created_at) VALUES(?,?,?,?,NULL,?,?,NOW(),?,?,0,?,NOW())').run(id, number, t.businessId, t.branchId, customer, String(x.customerEmail || '').trim() || null, due.toISOString(), total, String(x.notes || ''))
      for (const line of normalized) await tx.prepare('INSERT INTO invoice_items(id,invoice_id,business_id,name,quantity,unit_price) VALUES(?,?,?,?,?,?)').run(randomUUID(), id, t.businessId, line.name, line.quantity, line.unitPrice)
    })
    return send(res, 201, { id, invoiceNumber: number, total }), true
  }

  const match = path.match(/^\/api\/invoices\/([^/]+)$/)
  if (req.method === 'GET' && match) {
    const invoice = await db.prepare('SELECT * FROM invoices WHERE id=? AND business_id=? AND branch_id=?').get(match[1], t.businessId, t.branchId)
    if (!invoice) return send(res, 404, { error: 'Invoice not found' }), true
    return send(res, 200, { ...view(invoice), items: await db.prepare('SELECT * FROM invoice_items WHERE invoice_id=? AND business_id=?').all(invoice.id, t.businessId), payments: await db.prepare('SELECT * FROM invoice_payments WHERE invoice_id=? AND business_id=? ORDER BY created_at DESC').all(invoice.id, t.businessId) }), true
  }

  const pay = path.match(/^\/api\/invoices\/([^/]+)\/payments$/)
  if (req.method === 'POST' && pay) {
    const x = await json(req), invoice = await db.prepare('SELECT * FROM invoices WHERE id=? AND business_id=? AND branch_id=?').get(pay[1], t.businessId, t.branchId)
    if (!invoice) return send(res, 404, { error: 'Invoice not found' }), true
    const amount = Math.trunc(Number(x.amount))
    if (!Number.isFinite(amount) || amount <= 0 || amount > invoice.total - invoice.paid) return send(res, 400, { error: 'Payment must be positive and not exceed the balance' }), true
    await db.transaction(async (tx: any) => {
      await tx.prepare('INSERT INTO invoice_payments(id,invoice_id,business_id,branch_id,amount,method,created_at) VALUES(?,?,?,?,?,?,NOW())').run(randomUUID(), invoice.id, t.businessId, t.branchId, amount, String(x.method || 'Cash'))
      await tx.prepare('UPDATE invoices SET paid=paid+? WHERE id=? AND business_id=?').run(amount, invoice.id, t.businessId)
    })
    return send(res, 201, view(await db.prepare('SELECT * FROM invoices WHERE id=?').get(invoice.id))), true
  }

  if (req.method === 'DELETE' && match) {
    const invoice = await db.prepare('SELECT * FROM invoices WHERE id=? AND business_id=? AND branch_id=?').get(match[1], t.businessId, t.branchId)
    if (!invoice) return send(res, 404, { error: 'Invoice not found' }), true
    if (invoice.paid > 0 || invoice.source_order_id) return send(res, 409, { error: 'Paid or order-generated invoices cannot be deleted' }), true
    await db.transaction(async (tx: any) => {
      await tx.prepare('DELETE FROM invoice_items WHERE invoice_id=? AND business_id=?').run(invoice.id, t.businessId)
      await tx.prepare('DELETE FROM invoices WHERE id=? AND business_id=?').run(invoice.id, t.businessId)
    })
    return send(res, 200, { ok: true }), true
  }

  return false
}
