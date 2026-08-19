// @ts-nocheck
import { randomUUID } from 'node:crypto'

export async function initOperations(db: any): Promise<void> {
  // Tables already created by schema.sql
}

const body = async (r: any) => { let s = ''; for await (const c of r) s += c; return s ? JSON.parse(s) : {} }
const send = (r: any, s: number, v: any) => { const b = JSON.stringify(v); r.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); r.end(b) }
const loanStatus = (x: any) => x.amount_paid >= x.principal ? 'PAID' : new Date(x.due_date + 'T23:59:59') < new Date() ? 'OVERDUE' : x.amount_paid ? 'PARTIAL' : 'OPEN'

export async function operations(req: any, res: any, u: any, db: any, tenant: any): Promise<boolean> {
  const { businessId, branchId } = tenant

  if (req.method === 'GET' && u.pathname === '/api/inventory') {
    const items = (await db.prepare('SELECT * FROM ingredients WHERE business_id=? ORDER BY name').all(businessId)).map((x: any) => ({
      ...x,
      stockStatus: x.quantity <= 0 ? 'OUT' : x.quantity <= x.reorder_level ? 'LOW' : 'HEALTHY',
      stockValue: Math.round(x.quantity * x.unit_cost),
    }))
    send(res, 200, { items, summary: { items: items.length, low: items.filter((x: any) => x.stockStatus === 'LOW').length, out: items.filter((x: any) => x.stockStatus === 'OUT').length, value: items.reduce((n: number, x: any) => n + x.stockValue, 0) } })
    return true
  }

  const adjust = u.pathname.match(/^\/api\/inventory\/(\d+)\/adjust$/)
  if (req.method === 'POST' && adjust) {
    const x = await body(req), qty = Number(x.quantity)
    const item = await db.prepare('SELECT * FROM ingredients WHERE id=? AND business_id=?').get(+adjust[1], businessId)
    if (!item) return send(res, 404, { error: 'Ingredient not found' }), true
    if (!qty || !['RECEIVE', 'WASTE', 'ADJUST', 'COUNT'].includes(x.type)) return send(res, 400, { error: 'Invalid movement' }), true
    const signed = x.type === 'WASTE' ? -Math.abs(qty) : qty
    if (item.quantity + signed < 0) return send(res, 409, { error: 'Stock cannot be negative' }), true
    await db.transaction(async (tx: any) => {
      await tx.prepare('UPDATE ingredients SET quantity=quantity+?,updated_at=NOW() WHERE id=? AND business_id=?').run(signed, item.id, businessId)
      await tx.prepare('INSERT INTO stock_movements(id,ingredient_id,type,quantity,reason,created_at,business_id,branch_id,warehouse_id) VALUES(?,?,?,?,?,NOW(),?,?,?)').run(randomUUID(), item.id, x.type, signed, x.reason || x.type, businessId, branchId, item.warehouse_id)
    })
    send(res, 201, { ok: true }); return true
  }

  if (req.method === 'GET' && u.pathname === '/api/stock-movements') {
    send(res, 200, await db.prepare('SELECT m.*,i.name,i.unit FROM stock_movements m JOIN ingredients i ON i.id=m.ingredient_id AND i.business_id=m.business_id WHERE m.business_id=? AND m.branch_id=? ORDER BY m.created_at DESC LIMIT 100').all(businessId, branchId))
    return true
  }

  if (req.method === 'GET' && u.pathname === '/api/loans') {
    const items = (await db.prepare('SELECT * FROM loans WHERE business_id=? AND branch_id=? ORDER BY created_at DESC').all(businessId, branchId)).map((x: any) => ({ ...x, status: loanStatus(x), balance: x.principal - x.amount_paid }))
    send(res, 200, { items, summary: { outstanding: items.reduce((n: number, x: any) => n + x.balance, 0), overdue: items.filter((x: any) => x.status === 'OVERDUE').length, active: items.filter((x: any) => x.status !== 'PAID').length, recovered: items.reduce((n: number, x: any) => n + x.amount_paid, 0) } })
    return true
  }

  if (req.method === 'POST' && u.pathname === '/api/loans') {
    const x = await body(req), amount = Math.trunc(+x.principal)
    if (!x.borrowerName || amount <= 0 || !x.dueDate) return send(res, 400, { error: 'Borrower, amount and due date required' }), true
    await db.prepare('INSERT INTO loans(id,borrower_name,borrower_phone,borrower_type,principal,amount_paid,due_date,status,notes,created_at,business_id,branch_id) VALUES(?,?,?,?,?,?,?,?,?,NOW(),?,?)').run(randomUUID(), x.borrowerName, x.borrowerPhone || null, x.borrowerType || 'CUSTOMER', amount, 0, x.dueDate, 'OPEN', x.notes || null, businessId, branchId)
    send(res, 201, { ok: true }); return true
  }

  const repay = u.pathname.match(/^\/api\/loans\/([^/]+)\/repay$/)
  if (req.method === 'POST' && repay) {
    const x = await body(req), loan = await db.prepare('SELECT * FROM loans WHERE id=? AND business_id=? AND branch_id=?').get(repay[1], businessId, branchId), amount = Math.trunc(+x.amount)
    if (!loan) return send(res, 404, { error: 'Loan not found' }), true
    if (amount <= 0 || amount > loan.principal - loan.amount_paid) return send(res, 400, { error: 'Invalid repayment' }), true
    const paid = loan.amount_paid + amount
    await db.transaction(async (tx: any) => {
      await tx.prepare('INSERT INTO loan_repayments(id,loan_id,amount,method,created_at,business_id) VALUES(?,?,?,?,NOW(),?)').run(randomUUID(), loan.id, amount, x.method || 'Cash', businessId)
      await tx.prepare('UPDATE loans SET amount_paid=?,status=? WHERE id=? AND business_id=?').run(paid, paid === loan.principal ? 'PAID' : 'PARTIAL', loan.id, businessId)
    })
    send(res, 201, { balance: loan.principal - paid }); return true
  }

  return false
}
