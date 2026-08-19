// @ts-nocheck
// Platform-level backups using pg_dump (PostgreSQL) instead of SQLite's backup() API.
// The backup is triggered via shell exec of pg_dump and stored as a .sql file.
import { randomUUID } from 'node:crypto'
import { mkdir, unlink, stat } from 'node:fs/promises'
import { existsSync, createReadStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)
const send = (res: any, s: number, v: any, headers: any = {}) => { const b = JSON.stringify(v); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b), ...headers }); res.end(b) }
const read = async (req: any) => { let r = ''; for await (const c of req) r += c; return r ? JSON.parse(r) : {} }
const dir = () => fileURLToPath(new URL('../../data/backups/', import.meta.url))
const audit = async (db: any, userId: string, action: string, details: any = {}) => db.prepare('INSERT INTO platform_audit_logs(id,actor,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,?,NULL,?,NOW())').run(randomUUID(), userId || 'system', action, 'backup', JSON.stringify(details))

export async function initializePlatformBackups(db: any): Promise<void> {
  const put = async (k: string, v: string) => db.prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,NOW()) ON CONFLICT(key) DO NOTHING').run(k, v)
  for (const [k, v] of Object.entries({ autoBackupEnabled: 'true', backupFrequencyHours: '24', backupRetentionCount: '14', lastAutoBackupAt: '' })) await put(k, v)
}

export async function createPlatformBackup(db: any, requestedBy: string, type = 'MANUAL'): Promise<any> {
  const id = randomUUID(), file = `zentro-${type.toLowerCase()}-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`, path = dir() + file
  await db.prepare('INSERT INTO platform_backups(id,scope,status,size_bytes,requested_by,created_at,completed_at,file_path) VALUES(?,?,?,NULL,?,NOW(),NULL,NULL)').run(id, 'PLATFORM', 'RUNNING', requestedBy)
  try {
    await mkdir(dir(), { recursive: true })
    const dbUrl = process.env.DATABASE_URL || ''
    // pg_dump dumps all schema and data to a .sql file
    await execAsync(`pg_dump "${dbUrl}" -f "${path}" --no-password 2>&1`)
    const info = await stat(path)
    await db.prepare("UPDATE platform_backups SET status='COMPLETED',size_bytes=?,completed_at=NOW(),file_path=? WHERE id=?").run(info.size, path, id)
    await audit(db, requestedBy, 'CREATE_BACKUP', { file, type })
    await enforceRetention(db)
    return { id, status: 'COMPLETED', file }
  } catch (error: any) {
    console.error('[backup]', error)
    await db.prepare("UPDATE platform_backups SET status='FAILED',completed_at=NOW() WHERE id=?").run(id)
    throw error
  }
}

async function deleteBackup(db: any, id: string): Promise<boolean> {
  const row = await db.prepare('SELECT * FROM platform_backups WHERE id=?').get(id)
  if (!row) return false
  await db.prepare('DELETE FROM platform_backups WHERE id=?').run(id)
  if (row.file_path && existsSync(row.file_path)) await unlink(row.file_path).catch((err: any) => console.error(`Could not delete backup file:`, err.message))
  return true
}

async function enforceRetention(db: any): Promise<void> {
  const limitRow = await db.prepare("SELECT value FROM platform_settings WHERE key='backupRetentionCount'").get()
  const limit = Number(limitRow?.value || 14)
  const extra = await db.prepare(`SELECT id FROM platform_backups WHERE status='COMPLETED' ORDER BY created_at DESC OFFSET $1`).all(Math.max(1, limit))
  for (const row of extra) await deleteBackup(db, row.id).catch(() => {})
}

export async function handlePlatformBackups(req: any, res: any, url: any, db: any, user: any): Promise<boolean> {
  const path = url.pathname

  if (req.method === 'GET' && path === '/api/platform/backups') {
    const rows = await db.prepare('SELECT b.*,u.name AS requested_by_name FROM platform_backups b LEFT JOIN users u ON u.id=b.requested_by ORDER BY b.created_at DESC').all()
    const settings = Object.fromEntries((await db.prepare("SELECT key,value FROM platform_settings WHERE key IN ('autoBackupEnabled','backupFrequencyHours','backupRetentionCount','lastAutoBackupAt')").all()).map((x: any) => [x.key, x.value]))
    const completed = rows.filter((x: any) => x.status === 'COMPLETED')
    const summary = { total: rows.length, successful: completed.length, successRate: rows.length ? Math.round(completed.length / rows.length * 100 * 10) / 10 : 0, storageBytes: completed.reduce((n: number, x: any) => n + (x.size_bytes || 0), 0), lastBackup: completed[0] || null, nextEstimated: settings.autoBackupEnabled === 'true' && completed[0] ? new Date(new Date(completed[0].created_at).getTime() + Number(settings.backupFrequencyHours || 24) * 3600000).toISOString() : null }
    return send(res, 200, { items: rows, summary, settings }), true
  }

  if (req.method === 'POST' && path === '/api/platform/backups') {
    try { const result = await createPlatformBackup(db, user.id, 'MANUAL'); return send(res, 201, result), true }
    catch { return send(res, 500, { error: 'Backup failed — ensure pg_dump is installed on the server' }), true }
  }

  if (req.method === 'PATCH' && path === '/api/platform/backups/settings') {
    const x = await read(req)
    const put = async (k: string, v: string) => db.prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()').run(k, v)
    if (x.autoBackupEnabled !== undefined) await put('autoBackupEnabled', String(!!x.autoBackupEnabled))
    if (x.backupFrequencyHours !== undefined) await put('backupFrequencyHours', String(Math.max(1, Number(x.backupFrequencyHours) || 24)))
    if (x.backupRetentionCount !== undefined) await put('backupRetentionCount', String(Math.max(1, Number(x.backupRetentionCount) || 14)))
    await audit(db, user.id, 'UPDATE_BACKUP_SETTINGS', x)
    return send(res, 200, { ok: true }), true
  }

  const item = path.match(/^\/api\/platform\/backups\/([^/]+)$/)
  if (req.method === 'DELETE' && item) {
    const ok = await deleteBackup(db, item[1])
    if (ok) await audit(db, user.id, 'DELETE_BACKUP', { id: item[1] })
    return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Backup not found' }), true
  }

  const download = path.match(/^\/api\/platform\/backups\/([^/]+)\/download$/)
  if (req.method === 'GET' && download) {
    const row = await db.prepare('SELECT * FROM platform_backups WHERE id=?').get(download[1])
    if (!row || !row.file_path || !existsSync(row.file_path)) return send(res, 404, { error: 'Backup file not found on disk' }), true
    const info = await stat(row.file_path)
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': info.size, 'content-disposition': `attachment; filename="zentro-platform-backup-${row.id}.sql"` })
    createReadStream(row.file_path).pipe(res)
    await audit(db, user.id, 'DOWNLOAD_BACKUP', { id: row.id })
    return true
  }

  return false
}

let schedulerStarted = false
export function startBackupScheduler(db: any): void {
  if (schedulerStarted) return
  schedulerStarted = true
  setInterval(async () => {
    try {
      const settings = Object.fromEntries((await db.prepare("SELECT key,value FROM platform_settings WHERE key IN ('autoBackupEnabled','backupFrequencyHours','lastAutoBackupAt')").all()).map((x: any) => [x.key, x.value]))
      if (settings.autoBackupEnabled !== 'true') return
      const frequencyMs = Math.max(1, Number(settings.backupFrequencyHours || 24)) * 3600000
      const last = settings.lastAutoBackupAt ? new Date(settings.lastAutoBackupAt).getTime() : 0
      if (Date.now() - last < frequencyMs) return
      await createPlatformBackup(db, 'system', 'AUTOMATIC')
      await db.prepare("INSERT INTO platform_settings(key,value,updated_at) VALUES('lastAutoBackupAt',?,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()").run(new Date().toISOString())
    } catch (error) { console.error('Automatic backup failed', error) }
  }, 15 * 60000)
}
