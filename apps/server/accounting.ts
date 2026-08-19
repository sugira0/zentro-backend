// @ts-nocheck
import { randomUUID } from 'node:crypto'

const send = (res: any, s: number, v: any) => { const t = JSON.stringify(v); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(t) }); res.end(t) }
const read = async (req: any) => { let t = ''; for await (const c of req) t += c; return t ? JSON.parse(t) : {} }
const num = (v: any) => Number(v || 0)
const ageBucket = (date: string) => { const days = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 86400000)); return days <= 30 ? 'current' : days <= 60 ? '31_60' : days <= 90 ? '61_90' : 'over_90' }

export async function initializeAccounting(db: any): Promise<void> {
  // Schema already created by schema.sql
}

async function view(db: any, t: any): Promise<any> {
  const cash = num((await db.prepare("SELECT COALESCE(SUM(amount),0) AS value FROM payments WHERE business_id=? AND branch_id=? AND status='COMPLETED'").get(t.businessId, t.branchId))?.value) + num((await db.prepare('SELECT COALESCE(SUM(amount),0) AS value FROM invoice_payments WHERE business_id=? AND branch_id=?').get(t.businessId, t.branchId))?.value)
  const revenue = cash
  const expenses = num((await db.prepare("SELECT COALESCE(SUM(amount),0) AS value FROM expenses WHERE business_id=? AND (branch_id=? OR branch_id IS NULL) AND status IN ('APPROVED','PAID')").get(t.businessId, t.branchId))?.value)
  const inventory = num((await db.prepare('SELECT COALESCE(SUM(quantity*unit_cost),0) AS value FROM ingredients WHERE business_id=?').get(t.businessId))?.value)
  const receivables = num((await db.prepare('SELECT COALESCE(SUM(total-paid),0) AS value FROM invoices WHERE business_id=? AND branch_id=?').get(t.businessId, t.branchId))?.value)
  const payables = num((await db.prepare("SELECT COALESCE(SUM(total),0) AS value FROM purchase_orders WHERE business_id=? AND branch_id=? AND status NOT IN ('CANCELLED','PAID','COMPLETED')").get(t.businessId, t.branchId))?.value) + num((await db.prepare('SELECT COALESCE(SUM(outstanding),0) AS value FROM business_suppliers WHERE business_id=?').get(t.businessId))?.value)
  const loans = num((await db.prepare("SELECT COALESCE(SUM(principal-amount_paid),0) AS value FROM loans WHERE business_id=? AND branch_id=? AND borrower_type!='CUSTOMER'").get(t.businessId, t.branchId))?.value)
  const assets = Math.max(0, cash - expenses) + inventory + receivables, liabilities = payables + loans, equity = assets - liabilities, netProfit = revenue - expenses

  const accounts = [['1000','Cash & bank','ASSET',Math.max(0,cash-expenses)],['1100','Accounts receivable','ASSET',receivables],['1200','Inventory','ASSET',inventory],['2000','Accounts payable','LIABILITY',payables],['2100','Loans payable','LIABILITY',loans],['3000','Owner equity','EQUITY',equity],['4000','Sales revenue','REVENUE',revenue],['5000','Operating expenses','EXPENSE',expenses]].map(([code,name,type,balance]) => ({ code, name, type, balance: num(balance) }))

  const automatic = [
    ...(await db.prepare(`SELECT p.id,p.created_at AS date,'PAY-'||o.order_number AS reference,'Sale payment · Order #'||o.order_number AS description,'Cash & bank' AS account,'RECEIPT' AS type,0 AS debit,p.amount AS credit,'POSTED' AS status FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.business_id=? AND p.branch_id=? AND p.status='COMPLETED'`).all(t.businessId, t.branchId)),
    ...(await db.prepare(`SELECT e.id,e.incurred_at AS date,COALESCE(e.reference,'EXPENSE') AS reference,e.description,'Operating expenses' AS account,'EXPENSE' AS type,e.amount AS debit,0 AS credit,e.status FROM expenses e WHERE e.business_id=? AND (e.branch_id=? OR e.branch_id IS NULL)`).all(t.businessId, t.branchId)),
    ...(await db.prepare(`SELECT po.id,po.created_at AS date,po.po_number AS reference,'Purchase from '||COALESCE(s.name,'supplier') AS description,'Accounts payable' AS account,'PURCHASE' AS type,po.total AS debit,0 AS credit,po.status FROM purchase_orders po LEFT JOIN business_suppliers s ON s.id=po.supplier_id WHERE po.business_id=? AND po.branch_id=?`).all(t.businessId, t.branchId)),
  ]
  const manual = await db.prepare(`SELECT j.id,j.entry_date AS date,j.reference,j.description,'Manual journal' AS account,'JOURNAL' AS type,COALESCE(SUM(l.debit),0) AS debit,COALESCE(SUM(l.credit),0) AS credit,j.status FROM accounting_journals j LEFT JOIN accounting_journal_lines l ON l.journal_id=j.id AND l.business_id=j.business_id WHERE j.business_id=? AND (j.branch_id=? OR j.branch_id IS NULL) GROUP BY j.id`).all(t.businessId, t.branchId)
  const transactions = [...automatic, ...manual].sort((a: any, b: any) => String(b.date).localeCompare(String(a.date))).slice(0, 200)

  const ar: Record<string, number> = { current: 0, '31_60': 0, '61_90': 0, over_90: 0 }
  for (const row of await db.prepare('SELECT due_at,total-paid AS balance FROM invoices WHERE business_id=? AND branch_id=? AND paid<total').all(t.businessId, t.branchId)) ar[ageBucket(row.due_at)] += num(row.balance)
  const ap: Record<string, number> = { current: 0, '31_60': 0, '61_90': 0, over_90: 0 }
  for (const row of await db.prepare("SELECT COALESCE(expected_date,created_at) AS due,total AS balance FROM purchase_orders WHERE business_id=? AND branch_id=? AND status NOT IN ('CANCELLED','PAID','COMPLETED')").all(t.businessId, t.branchId)) ap[ageBucket(row.due)] += num(row.balance)

  const monthly = (await db.prepare("SELECT TO_CHAR(incurred_at,'YYYY-MM') AS month,SUM(amount) AS expenses FROM expenses WHERE business_id=? AND (branch_id=? OR branch_id IS NULL) AND status IN ('APPROVED','PAID') GROUP BY month ORDER BY month DESC LIMIT 12").all(t.businessId, t.branchId)).reverse()

  return { generatedAt: new Date().toISOString(), summary: { assets, liabilities, equity, netProfit, revenue, expenses, cash: Math.max(0, cash - expenses), receivables, payables, inventory }, accounts, transactions, aging: { ar, ap }, monthly }
}

export async function handleAccounting(req: any, res: any, url: any, db: any, t: any): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/accounting') return send(res, 200, await view(db, t)), true

  if (req.method === 'POST' && url.pathname === '/api/accounting/journals') {
    const input = await read(req), lines = Array.isArray(input.lines) ? input.lines : []
    const debits = lines.reduce((n: number, x: any) => n + Math.max(0, Math.round(num(x.debit))), 0)
    const credits = lines.reduce((n: number, x: any) => n + Math.max(0, Math.round(num(x.credit))), 0)
    if (!input.description || lines.length < 2 || debits <= 0 || debits !== credits) return send(res, 400, { error: 'A journal needs a description, at least two lines, and equal debits and credits' }), true
    const id = randomUUID()
    const countRow = await db.prepare('SELECT COUNT(*) AS n FROM accounting_journals WHERE business_id=?').get(t.businessId)
    const reference = `JE-${new Date().getFullYear()}-${String(countRow.n + 1).padStart(5, '0')}`
    await db.transaction(async (tx: any) => {
      await tx.prepare('INSERT INTO accounting_journals(id,business_id,branch_id,reference,entry_date,description,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,NOW())').run(id, t.businessId, t.branchId, reference, input.entryDate || new Date().toISOString().slice(0, 10), input.description, 'POSTED', t.userId)
      for (const line of lines) await tx.prepare('INSERT INTO accounting_journal_lines(id,journal_id,business_id,account_code,account_name,debit,credit) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, t.businessId, line.accountCode, line.accountName || line.accountCode, Math.max(0, Math.round(num(line.debit))), Math.max(0, Math.round(num(line.credit))))
    })
    return send(res, 201, { id, reference }), true
  }

  return false
}
