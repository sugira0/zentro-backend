// @ts-nocheck
import { randomUUID } from 'node:crypto'
import { handleTenantSubscriptions, initializeTenantSubscriptions } from './tenant-subscription.ts'

const send = (res: any, s: number, v: any) => { const p = JSON.stringify(v); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(p) }); res.end(p) }
const read = async (req: any) => { let r = ''; for await (const c of req) r += c; return r ? JSON.parse(r) : {} }
const num = (v: any) => Math.round(Number(v || 0))

export async function initializeCashBank(db: any): Promise<void> {
  await initializeTenantSubscriptions(db)
  // Seed default cash accounts for existing businesses
  const businesses = await db.prepare('SELECT id FROM businesses').all()
  for (const business of businesses) {
    const branch = await db.prepare("SELECT id FROM branches WHERE business_id=? AND status='ACTIVE' ORDER BY created_at LIMIT 1").get(business.id)
    if (!branch) continue
    const existing = await db.prepare('SELECT 1 FROM cash_accounts WHERE business_id=? LIMIT 1').get(business.id)
    if (existing) continue
    await db.prepare("INSERT INTO cash_accounts(id,business_id,branch_id,name,type,currency,bank_name,account_number,opening_balance,status,created_at) VALUES(?,?,?,'Petty Cash','CASH','RWF',NULL,NULL,0,'ACTIVE',NOW()) ON CONFLICT DO NOTHING").run(randomUUID(), business.id, branch.id)
    await db.prepare("INSERT INTO cash_accounts(id,business_id,branch_id,name,type,currency,bank_name,account_number,opening_balance,status,created_at) VALUES(?,?,?,'Main Operating Account','BANK','RWF','BK Ltd',NULL,0,'ACTIVE',NOW()) ON CONFLICT DO NOTHING").run(randomUUID(), business.id, branch.id)
  }
}

async function view(db: any, t: any): Promise<any> {
  const accounts = await db.prepare(`
    SELECT a.*,a.opening_balance+
      COALESCE((SELECT SUM(CASE WHEN type IN ('CASH_IN','TRANSFER_IN') THEN amount ELSE -amount END) FROM cash_transactions x WHERE x.account_id=a.id AND x.status='COMPLETED'),0) AS balance
    FROM cash_accounts a WHERE a.business_id=? AND (a.branch_id=? OR a.branch_id IS NULL) AND a.status='ACTIVE'
    ORDER BY a.type,a.created_at`).all(t.businessId, t.branchId)
  const cashAccount = accounts.find((x: any) => x.type === 'CASH')
  const bankAccount = accounts.find((x: any) => x.type === 'BANK')
  const automatic = [
    ...(await db.prepare(`SELECT p.id,p.created_at AS transaction_date,'Sales payment · Order #'||o.order_number AS description,CASE WHEN lower(p.method)='cash' THEN 'CASH_IN' ELSE 'BANK_IN' END AS type,p.amount,'PAY-'||o.order_number AS reference,'COMPLETED' AS status,p.method AS source FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.business_id=? AND p.branch_id=? AND p.status='COMPLETED'`).all(t.businessId, t.branchId)).map((x: any) => ({ ...x, account_id: String(x.source).toLowerCase() === 'cash' ? cashAccount?.id : bankAccount?.id, account_name: String(x.source).toLowerCase() === 'cash' ? cashAccount?.name : bankAccount?.name })),
    ...(await db.prepare(`SELECT id,incurred_at AS transaction_date,description,'CASH_OUT' AS type,amount,COALESCE(reference,'EXPENSE') AS reference,status,payment_method AS source FROM expenses WHERE business_id=? AND (branch_id=? OR branch_id IS NULL) AND status IN ('APPROVED','PAID')`).all(t.businessId, t.branchId)).map((x: any) => ({ ...x, account_id: String(x.source).toLowerCase() === 'cash' ? cashAccount?.id : bankAccount?.id, account_name: String(x.source).toLowerCase() === 'cash' ? cashAccount?.name : bankAccount?.name })),
  ]
  const manual = await db.prepare(`SELECT x.*,a.name AS account_name FROM cash_transactions x JOIN cash_accounts a ON a.id=x.account_id WHERE x.business_id=? AND (x.branch_id=? OR x.branch_id IS NULL) ORDER BY x.transaction_date DESC`).all(t.businessId, t.branchId)
  const transactions = [...automatic, ...manual].sort((a: any, b: any) => String(b.transaction_date).localeCompare(String(a.transaction_date)))
  const inflow = transactions.filter((x: any) => String(x.type).includes('IN')).reduce((n: number, x: any) => n + num(x.amount), 0)
  const outflow = transactions.filter((x: any) => String(x.type).includes('OUT')).reduce((n: number, x: any) => n + num(x.amount), 0)
  const cashBalance = Math.max(0, accounts.filter((x: any) => x.type === 'CASH').reduce((n: number, x: any) => n + num(x.balance), 0))
  const bankBalance = Math.max(0, accounts.filter((x: any) => x.type === 'BANK').reduce((n: number, x: any) => n + num(x.balance), 0))
  const reconciliations = await Promise.all(accounts.filter((x: any) => x.type === 'BANK').map(async (account: any) => (await db.prepare('SELECT * FROM bank_reconciliations WHERE business_id=? AND account_id=? ORDER BY created_at DESC LIMIT 1').get(t.businessId, account.id)) || { account_id: account.id, account_name: account.name, status: 'PENDING', progress: 0, reconciled_at: null }))
  return { accounts, transactions: transactions.slice(0, 250), reconciliations, summary: { cashBalance, bankBalance, totalBalance: cashBalance + bankBalance, inflow, outflow, netCashFlow: inflow - outflow }, generatedAt: new Date().toISOString() }
}

export async function handleCashBank(req: any, res: any, url: any, db: any, t: any): Promise<boolean> {
  if (await handleTenantSubscriptions(req, res, url, db, t)) return true

  if (req.method === 'GET' && url.pathname === '/api/cash-bank') return send(res, 200, await view(db, t)), true

  if (req.method === 'POST' && url.pathname === '/api/cash-bank/accounts') {
    const input = await read(req), name = String(input.name || '').trim(), type = String(input.type || 'CASH').toUpperCase()
    if (!name || !['CASH', 'BANK'].includes(type)) return send(res, 400, { error: 'Account name and a valid account type are required' }), true
    const id = randomUUID()
    await db.prepare('INSERT INTO cash_accounts(id,business_id,branch_id,name,type,currency,bank_name,account_number,opening_balance,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,NOW())').run(id, t.businessId, t.branchId, name, type, input.currency || 'RWF', input.bankName || null, input.accountNumber || null, num(input.openingBalance), 'ACTIVE')
    return send(res, 201, { id }), true
  }

  if (req.method === 'POST' && url.pathname === '/api/cash-bank/transactions') {
    const input = await read(req)
    const account = await db.prepare("SELECT * FROM cash_accounts WHERE id=? AND business_id=? AND status='ACTIVE'").get(input.accountId, t.businessId)
    const amount = num(input.amount), type = String(input.type || '').toUpperCase()
    if (!account || amount <= 0 || !['CASH_IN', 'CASH_OUT'].includes(type)) return send(res, 400, { error: 'Choose an account, transaction type and valid amount' }), true
    const id = randomUUID(), reference = String(input.reference || `CB-${Date.now().toString().slice(-8)}`)
    await db.prepare('INSERT INTO cash_transactions(id,business_id,branch_id,account_id,counter_account_id,type,amount,description,reference,status,transaction_date,created_by,created_at) VALUES(?,?,?,?,NULL,?,?,?,?,?,?,?,NOW())').run(id, t.businessId, t.branchId, account.id, type, amount, String(input.description || type.replace('_', ' ')), reference, 'COMPLETED', input.transactionDate || new Date().toISOString().slice(0, 10), t.userId)
    return send(res, 201, { id, reference }), true
  }

  if (req.method === 'POST' && url.pathname === '/api/cash-bank/transfers') {
    const input = await read(req)
    const from = await db.prepare("SELECT * FROM cash_accounts WHERE id=? AND business_id=? AND status='ACTIVE'").get(input.fromAccountId, t.businessId)
    const to = await db.prepare("SELECT * FROM cash_accounts WHERE id=? AND business_id=? AND status='ACTIVE'").get(input.toAccountId, t.businessId)
    const amount = num(input.amount)
    if (!from || !to || from.id === to.id || amount <= 0) return send(res, 400, { error: 'Select two different accounts and a valid transfer amount' }), true
    const reference = `TRF-${Date.now().toString().slice(-8)}`
    await db.transaction(async (tx: any) => {
      await tx.prepare('INSERT INTO cash_transactions(id,business_id,branch_id,account_id,counter_account_id,type,amount,description,reference,status,transaction_date,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NOW())').run(randomUUID(), t.businessId, t.branchId, from.id, to.id, 'TRANSFER_OUT', amount, String(input.description || `Transfer to ${to.name}`), reference, 'COMPLETED', input.transactionDate || new Date().toISOString().slice(0, 10), t.userId)
      await tx.prepare('INSERT INTO cash_transactions(id,business_id,branch_id,account_id,counter_account_id,type,amount,description,reference,status,transaction_date,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NOW())').run(randomUUID(), t.businessId, t.branchId, to.id, from.id, 'TRANSFER_IN', amount, String(input.description || `Transfer from ${from.name}`), reference, 'COMPLETED', input.transactionDate || new Date().toISOString().slice(0, 10), t.userId)
    })
    return send(res, 201, { reference }), true
  }

  return false
}
