// @ts-nocheck
import { randomUUID } from 'node:crypto'
import { handleStaff } from './staff.ts'
import { handleRoles } from './roles.ts'
import { handleReports } from './reports.ts'

const send = (res: any, s: number, v: any) => { const t = JSON.stringify(v); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(t) }); res.end(t) }
const read = async (req: any) => { let t = ''; for await (const c of req) t += c; return t ? JSON.parse(t) : {} }
const money = (v: any) => Math.max(0, Math.round(Number(v) || 0))
const computedStatus = (row: any) => row.amount_paid >= row.principal ? 'COMPLETED' : new Date(row.due_date) < new Date(new Date().toISOString().slice(0, 10)) ? 'OVERDUE' : 'ACTIVE'
const ageKey = (date: string) => { const d = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 86400000)); return d <= 30 ? '0_30' : d <= 60 ? '31_60' : d <= 90 ? '61_90' : d <= 180 ? '91_180' : '180_plus' }

export async function handleLoans(req: any, res: any, url: any, db: any, t: any): Promise<boolean> {
  if (url.pathname.startsWith('/api/roles')) return handleRoles(req, res, url, db, t)
  if (url.pathname.startsWith('/api/staff')) return handleStaff(req, res, url, db, t)
  if (url.pathname.startsWith('/api/reports')) return handleReports(req, res, url, db, t)

  if (req.method === 'GET' && url.pathname === '/api/loans') {
    const items = (await db.prepare(`SELECT l.*,(l.principal-l.amount_paid) AS outstanding,(SELECT COUNT(*) FROM loan_repayments r WHERE r.loan_id=l.id AND r.business_id=l.business_id) AS repayment_count FROM loans l WHERE l.business_id=? AND l.branch_id=? AND l.borrower_type='CUSTOMER' ORDER BY l.created_at DESC`).all(t.businessId, t.branchId)).map((x: any) => ({ ...x, status: computedStatus(x) }))
    const repayments = await db.prepare(`SELECT r.*,l.borrower_name,l.due_date,l.principal AS loan_principal,l.amount_paid AS total_paid,(l.principal-l.amount_paid) AS current_balance FROM loan_repayments r JOIN loans l ON l.id=r.loan_id AND l.business_id=r.business_id WHERE r.business_id=? AND l.branch_id=? ORDER BY r.created_at DESC`).all(t.businessId, t.branchId)
    const total = items.reduce((n: number, x: any) => n + x.principal, 0), outstanding = items.reduce((n: number, x: any) => n + x.outstanding, 0), repaid = items.reduce((n: number, x: any) => n + x.amount_paid, 0), overdueItems = items.filter((x: any) => x.status === 'OVERDUE'), defaultAmount = overdueItems.reduce((n: number, x: any) => n + x.outstanding, 0)
    const aging: Record<string, number> = { _0_30: 0, _31_60: 0, _61_90: 0, _91_180: 0, _180_plus: 0 }
    for (const loan of items.filter((x: any) => x.outstanding > 0)) aging[`_${ageKey(loan.due_date)}`] += loan.outstanding
    const monthly = (await db.prepare(`SELECT TO_CHAR(created_at,'YYYY-MM') AS month,SUM(amount) AS amount FROM loan_repayments WHERE business_id=? GROUP BY month ORDER BY month DESC LIMIT 12`).all(t.businessId)).reverse()
    return send(res, 200, { items, repayments, aging, monthly, summary: { total, outstanding, repaid, defaultAmount, defaultRate: outstanding ? defaultAmount / outstanding * 100 : 0, active: items.filter((x: any) => x.status === 'ACTIVE').length, completed: items.filter((x: any) => x.status === 'COMPLETED').length, overdue: overdueItems.length, average: items.length ? total / items.length : 0, collectionRate: total ? repaid / total * 100 : 0 }, activities: [...repayments.slice(0, 4).map((x: any) => ({ type: 'PAYMENT', title: `Loan payment received from ${x.borrower_name}`, amount: x.amount, createdAt: x.created_at })), ...items.slice(0, 4).map((x: any) => ({ type: 'LOAN', title: `Customer loan created for ${x.borrower_name}`, amount: x.principal, createdAt: x.created_at }))].sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 6) }), true
  }

  if (req.method === 'POST' && url.pathname === '/api/loans') {
    const x = await read(req), principal = money(x.principal)
    if (!String(x.borrowerName || '').trim() || principal <= 0 || !x.dueDate) return send(res, 400, { error: 'Customer, loan amount and due date are required' }), true
    const due = new Date(x.dueDate)
    if (Number.isNaN(due.getTime())) return send(res, 400, { error: 'Enter a valid due date' }), true
    const id = randomUUID()
    await db.prepare('INSERT INTO loans(id,borrower_name,borrower_phone,borrower_type,principal,amount_paid,due_date,status,notes,created_at,business_id,branch_id,borrower_email) VALUES(?,?,?,?,?,?,?,?,?,NOW(),?,?,?)').run(id, String(x.borrowerName).trim(), String(x.borrowerPhone || '').trim() || null, 'CUSTOMER', principal, 0, due.toISOString().slice(0, 10), 'ACTIVE', String(x.notes || '').trim() || null, t.businessId, t.branchId, String(x.borrowerEmail || '').trim() || null)
    return send(res, 201, { id }), true
  }

  const repay = url.pathname.match(/^\/api\/loans\/([^/]+)\/repay$/)
  if (req.method === 'POST' && repay) {
    const x = await read(req), loan = await db.prepare(`SELECT * FROM loans WHERE id=? AND business_id=? AND branch_id=? AND borrower_type='CUSTOMER'`).get(repay[1], t.businessId, t.branchId), amount = money(x.amount)
    if (!loan) return send(res, 404, { error: 'Customer loan not found' }), true
    const balance = loan.principal - loan.amount_paid
    if (amount <= 0 || amount > balance) return send(res, 400, { error: `Payment must be between RWF 1 and RWF ${balance.toLocaleString()}` }), true
    const paid = loan.amount_paid + amount
    await db.transaction(async (tx: any) => {
      await tx.prepare('INSERT INTO loan_repayments(id,loan_id,amount,method,created_at,business_id) VALUES(?,?,?,?,NOW(),?)').run(randomUUID(), loan.id, amount, x.method || 'Cash', t.businessId)
      await tx.prepare('UPDATE loans SET amount_paid=?,status=? WHERE id=? AND business_id=?').run(paid, paid >= loan.principal ? 'PAID' : 'PARTIAL', loan.id, t.businessId)
    })
    return send(res, 201, { balance: loan.principal - paid }), true
  }

  return false
}
