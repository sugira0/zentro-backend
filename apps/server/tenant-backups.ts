// @ts-nocheck
import { randomUUID } from 'node:crypto'

const send = (res: any, s: number, v: any, headers: any = {}) => { const b = JSON.stringify(v); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b), ...headers }); res.end(b) }
const read = async (req: any) => { let r = ''; for await (const c of req) r += c; return r ? JSON.parse(r) : {} }

// Tables that should NOT be included in a tenant backup snapshot
const excluded = new Set(['businesses','business_types','business_type_modules','business_modules','business_module_assignments','subscription_plans','subscriptions','users','business_users','roles','permissions','role_permissions','audit_logs','auth_sessions','tenant_backups','platform_backups','platform_exports','platform_settings','platform_setting_changes'])

async function tenantTables(db: any): Promise<string[]> {
  const rows = await db.prepare(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`).all()
  const result: string[] = []
  for (const row of rows) {
    const name = row.table_name
    if (excluded.has(name)) continue
    const colCheck = await db.prepare(`SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='business_id'`).get(name)
    if (colCheck) result.push(name)
  }
  return result
}

async function snapshot(db: any, businessId: string): Promise<any> {
  const tables: Record<string, any[]> = {}
  for (const table of await tenantTables(db)) {
    tables[table] = await db.prepare(`SELECT * FROM "${table}" WHERE business_id=?`).all(businessId)
  }
  return { version: 1, createdAt: new Date().toISOString(), businessId, tables }
}

async function create(db: any, tenant: any, type = 'MANUAL'): Promise<any> {
  const data = await snapshot(db, tenant.businessId)
  const raw = JSON.stringify(data), id = randomUUID()
  const name = `${type === 'AUTOMATIC' ? 'Auto' : 'Manual'} Backup - ${new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date())}`
  await db.prepare('INSERT INTO tenant_backups(id,business_id,branch_id,name,type,status,size_bytes,snapshot_json,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,NOW(),NOW())').run(id, tenant.businessId, tenant.branchId, name, type, 'SUCCESS', Buffer.byteLength(raw), raw)
  return { id, name, type, status: 'SUCCESS', size_bytes: Buffer.byteLength(raw), created_at: new Date().toISOString(), completed_at: new Date().toISOString() }
}

export async function initializeTenantBackups(db: any): Promise<void> {
  // Schema already created by schema.sql
}

export async function handleTenantBackups(req: any, res: any, url: any, db: any, tenant: any): Promise<boolean> {
  const path = url.pathname

  if (req.method === 'GET' && path === '/api/backups') {
    const items = await db.prepare('SELECT id,name,type,status,size_bytes,created_at,completed_at FROM tenant_backups WHERE business_id=? ORDER BY created_at DESC').all(tenant.businessId)
    const used = items.reduce((s: number, r: any) => s + r.size_bytes, 0)
    return send(res, 200, { items, summary: { total: items.length, usedBytes: used, limitBytes: 50 * 1024 * 1024, lastBackup: items[0] || null } }), true
  }

  if (req.method === 'POST' && path === '/api/backups') {
    const input = await read(req), record = await create(db, tenant, String(input.type || 'MANUAL').toUpperCase() === 'AUTOMATIC' ? 'AUTOMATIC' : 'MANUAL')
    return send(res, 201, record), true
  }

  const download = path.match(/^\/api\/backups\/([^/]+)\/download$/)
  if (req.method === 'GET' && download) {
    const row = await db.prepare('SELECT * FROM tenant_backups WHERE id=? AND business_id=?').get(download[1], tenant.businessId)
    if (!row) return send(res, 404, { error: 'Backup not found' }), true
    return send(res, 200, JSON.parse(row.snapshot_json), { 'content-disposition': `attachment; filename="zentro-backup-${row.id}.json"` }), true
  }

  const restore = path.match(/^\/api\/backups\/([^/]+)\/restore$/)
  if (req.method === 'POST' && restore) {
    const row = await db.prepare('SELECT * FROM tenant_backups WHERE id=? AND business_id=?').get(restore[1], tenant.businessId)
    if (!row) return send(res, 404, { error: 'Backup not found' }), true
    const input = await read(req)
    if (String(input.confirmation || '').trim().toUpperCase() !== 'RESTORE') return send(res, 400, { error: 'Type RESTORE to confirm this operation' }), true
    const data = JSON.parse(row.snapshot_json)
    const validTables = new Set(await tenantTables(db))
    // Auto-save a backup before restoring
    await create(db, tenant, 'AUTOMATIC')
    await db.transaction(async (tx: any) => {
      for (const [table, records] of Object.entries(data.tables || {})) {
        if (excluded.has(table) || !validTables.has(table)) continue
        await tx.prepare(`DELETE FROM "${table}" WHERE business_id=?`).run(tenant.businessId)
        if (!Array.isArray(records) || !records.length) continue
        const keys = Object.keys((records as any[])[0])
        const sql = `INSERT INTO "${table}"(${keys.map(k => `"${k}"`).join(',')}) VALUES(${keys.map(() => '?').join(',')})`
        for (const record of records as any[]) await tx.prepare(sql).run(...keys.map(k => record[k]))
      }
    })
    return send(res, 200, { ok: true, restoredFrom: row.id }), true
  }

  return false
}
