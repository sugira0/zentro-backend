// @ts-nocheck
import { randomUUID } from 'node:crypto'

const send = (res: any, s: number, v: any) => { const t = JSON.stringify(v); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(t) }); res.end(t) }
const read = async (req: any) => { let t = ''; for await (const c of req) t += c; return t ? JSON.parse(t) : {} }
const scalar = async (db: any, sql: string, args: any[] = []) => Number((await db.prepare(sql).get(...args))?.value || 0)
const reportTypes = [
  ['sales','Sales Reports','Analyze sales performance and revenue trends.',6],
  ['inventory','Inventory Reports','Track stock levels, movement and valuation.',5],
  ['financial','Financial Reports','Review financial statements and profitability.',7],
  ['expense','Expense Reports','Monitor and analyze business expenses.',4],
  ['customer','Customer Reports','Understand customer behavior and sales.',4],
  ['supplier','Supplier Reports','Evaluate supplier performance and purchases.',3],
  ['staff','Staff Reports','Monitor staff performance and attendance.',5],
  ['loan','Loan Reports','Track loans, repayments and performance.',6],
  ['accounting','Accounting Reports','General ledger and accounting reports.',6],
  ['cash-bank','Cash & Bank Reports','Cash flow and bank transaction reports.',5],
  ['tax','Tax Reports','Tax summary and compliance reports.',3],
  ['activity','Activity Reports','System activity and audit trail reports.',4],
]

export async function initializeReports(db: any): Promise<void> {
  // Schema already created by schema.sql
}

async function payload(db: any, t: any): Promise<any> {
  const b = [t.businessId], bb = [t.businessId, t.branchId]
  const revenue = await scalar(db, "SELECT COALESCE(SUM(amount),0) AS value FROM payments WHERE business_id=$1 AND branch_id=$2 AND status='COMPLETED'", bb)
  const sales = await scalar(db, "SELECT COALESCE(SUM(total),0) AS value FROM orders WHERE business_id=$1 AND branch_id=$2 AND status IN ('PAID','CREDIT','DELIVERED')", bb)
  const expenses = await scalar(db, 'SELECT COALESCE(SUM(amount),0) AS value FROM expenses WHERE business_id=$1 AND branch_id=$2', bb)
  const purchases = await scalar(db, 'SELECT COALESCE(SUM(total),0) AS value FROM purchase_orders WHERE business_id=$1 AND branch_id=$2', bb)
  const customers = await scalar(db, 'SELECT COUNT(*) AS value FROM customers WHERE business_id=$1', b)
  const branches = await db.prepare("SELECT id,name FROM branches WHERE business_id=? AND status='ACTIVE' ORDER BY name").all(t.businessId)
  const generated = await db.prepare('SELECT * FROM generated_reports WHERE business_id=? AND (branch_id IS NULL OR branch_id=?) ORDER BY created_at DESC LIMIT 20').all(t.businessId, t.branchId)
  return { summary: { revenue, sales, expenses, purchases, customers }, branches, reportTypes: reportTypes.map(([code, name, description, count]) => ({ code, name, description, count })), generated }
}

export async function handleReports(req: any, res: any, url: any, db: any, t: any): Promise<boolean> {
  if (!url.pathname.startsWith('/api/reports')) return false

  if (req.method === 'GET' && url.pathname === '/api/reports') return send(res, 200, await payload(db, t)), true

  if (req.method === 'POST' && url.pathname === '/api/reports/generate') {
    const x = await read(req), name = String(x.name || '').trim()
    if (!name) return send(res, 400, { error: 'Report name is required' }), true
    const id = randomUUID(), format = ['PDF','EXCEL','CSV'].includes(String(x.format || '').toUpperCase()) ? String(x.format).toUpperCase() : 'PDF'
    await db.prepare('INSERT INTO generated_reports(id,business_id,branch_id,report_name,report_type,date_from,date_to,format,generated_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,NOW())').run(id, t.businessId, x.branchId || t.branchId, name, String(x.type || 'custom'), x.dateFrom || null, x.dateTo || null, format, 'Current user')
    return send(res, 201, { id, createdAt: new Date().toISOString() }), true
  }

  return false
}
