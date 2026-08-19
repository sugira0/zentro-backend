// @ts-nocheck
import { randomUUID } from 'node:crypto'

const send = (res: any, s: number, v: any) => { const p = JSON.stringify(v); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(p) }); res.end(p) }
const read = async (req: any) => { let v = ''; for await (const c of req) v += c; return v ? JSON.parse(v) : {} }

export async function initializeExpenses(db: any): Promise<void> {
  // Schema already created by schema.sql
}

export async function handleExpenses(req: any, res: any, url: any, db: any, tenant: any): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/expenses') {
    return send(res, 200, await db.prepare('SELECT * FROM expenses WHERE business_id=? AND (branch_id=? OR branch_id IS NULL) ORDER BY incurred_at DESC,created_at DESC').all(tenant.businessId, tenant.branchId)), true
  }

  if (req.method === 'POST' && url.pathname === '/api/expenses') {
    const input = await read(req), amount = Math.round(Number(input.amount || 0))
    const description = String(input.description || '').trim(), category = String(input.category || 'Other').trim()
    if (!description || amount <= 0) return send(res, 400, { error: 'Description and a valid expense amount are required' }), true
    const id = randomUUID()
    const incurredAt = input.incurredAt ? new Date(`${input.incurredAt}T12:00:00`).toISOString() : new Date().toISOString()
    await db.prepare('INSERT INTO expenses(id,business_id,branch_id,category,amount,description,incurred_at,created_at,payment_method,status,reference,notes,updated_at) VALUES(?,?,?,?,?,?,?,NOW(),?,?,?,?,NOW())').run(id, tenant.businessId, tenant.branchId, category, amount, description, incurredAt, input.paymentMethod || 'Cash', input.status || 'PAID', input.reference || `EXP-${Date.now().toString().slice(-7)}`, input.notes || '')
    return send(res, 201, { id }), true
  }

  const match = url.pathname.match(/^\/api\/expenses\/([^/]+)$/)
  if (match && req.method === 'PATCH') {
    const current = await db.prepare('SELECT * FROM expenses WHERE id=? AND business_id=? AND (branch_id=? OR branch_id IS NULL)').get(match[1], tenant.businessId, tenant.branchId)
    if (!current) return send(res, 404, { error: 'Expense not found' }), true
    const input = await read(req), status = input.status || current.status
    if (!['DRAFT', 'PENDING', 'APPROVED', 'PAID', 'REJECTED'].includes(status)) return send(res, 400, { error: 'Invalid expense status' }), true
    await db.prepare('UPDATE expenses SET status=?,payment_method=?,reference=?,notes=?,updated_at=NOW() WHERE id=? AND business_id=?').run(status, input.paymentMethod || current.payment_method, input.reference ?? current.reference, input.notes ?? current.notes, current.id, tenant.businessId)
    return send(res, 200, { ok: true }), true
  }

  return false
}
