// @ts-nocheck
import { randomUUID } from 'node:crypto'

const send = (res: any, s: number, v: any) => { const t = JSON.stringify(v); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(t) }); res.end(t) }
const read = async (req: any) => { let r = ''; for await (const c of req) r += c; return r ? JSON.parse(r) : {} }

export async function initializeSupportRequests(db: any): Promise<void> {
  // Schema already created by schema.sql
}

export async function handleSupportRequests(req: any, res: any, url: any, db: any, tenant: any): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/support-requests') {
    const items = await db.prepare('SELECT * FROM support_requests WHERE business_id=? ORDER BY created_at DESC LIMIT 50').all(tenant.businessId)
    return send(res, 200, items), true
  }

  if (req.method === 'POST' && url.pathname === '/api/support-requests') {
    const x = await read(req), subject = String(x.subject || '').trim(), message = String(x.message || '').trim()
    const priority = ['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(x.priority) ? x.priority : 'NORMAL'
    if (!subject || !message) return send(res, 400, { error: 'Subject and message are required' }), true
    const id = randomUUID()
    await db.prepare('INSERT INTO support_requests(id,business_id,branch_id,subject,message,status,priority,requested_by,created_at) VALUES(?,?,?,?,?,?,?,?,NOW())').run(id, tenant.businessId, tenant.branchId, subject, message, 'OPEN', priority, tenant.userId)
    return send(res, 201, { id }), true
  }

  return false
}
