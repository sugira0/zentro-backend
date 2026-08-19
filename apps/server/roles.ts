// @ts-nocheck
import { randomUUID } from 'node:crypto'

const send = (res: any, s: number, v: any) => { const t = JSON.stringify(v); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(t) }); res.end(t) }
const read = async (req: any) => { let t = ''; for await (const c of req) t += c; return t ? JSON.parse(t) : {} }

const modules = [
  ['dashboard','Dashboard'],['sales','Sales'],['customers','Customers'],['products','Products'],
  ['inventory','Inventory'],['procurement','Procurement'],['expenses','Expenses'],['accounting','Accounting'],
  ['cash_bank','Cash & Bank'],['loans','Loans'],['staff','Staff'],['reports','Reports'],['settings','Settings'],
]
const actions = ['view','create','edit','delete','approve','export']
const allowed = (t: any) => t.role === 'BUSINESS_OWNER' || t.permissions.includes('staff.edit')

async function ensurePermissions(db: any): Promise<void> {
  for (const [code, name] of modules) {
    for (const action of actions) {
      await db.prepare('INSERT INTO permissions(id,code,name) VALUES(?,?,?) ON CONFLICT(code) DO NOTHING').run(randomUUID(), `${code}.${action}`, `${action[0].toUpperCase() + action.slice(1)} ${name}`)
    }
  }
}

async function payload(db: any, businessId: string): Promise<any> {
  await ensurePermissions(db)
  const permissions = await db.prepare(`SELECT id,code,name FROM permissions WHERE code LIKE '%.%' ORDER BY code`).all()
  const roles = await db.prepare(`SELECT r.id,r.code,r.name,r.is_system,r.created_at,COUNT(bu.id) AS user_count FROM roles r LEFT JOIN business_users bu ON bu.role_id=r.id AND bu.business_id=r.business_id WHERE r.business_id=? GROUP BY r.id ORDER BY r.is_system DESC,r.name`).all(businessId)
  const links = await db.prepare(`SELECT rp.role_id,p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id JOIN roles r ON r.id=rp.role_id WHERE r.business_id=?`).all(businessId)
  const allCodes = permissions.map((x: any) => x.code)
  return { roles: roles.map((role: any) => ({ ...role, permissions: role.code === 'BUSINESS_OWNER' ? allCodes : links.filter((x: any) => x.role_id === role.id).map((x: any) => x.code) })), modules: modules.map(([code, name]) => ({ code, name, actions: actions.map(action => ({ action, code: `${code}.${action}`, name: permissions.find((x: any) => x.code === `${code}.${action}`)?.name })) })), actions }
}

export async function handleRoles(req: any, res: any, url: any, db: any, t: any): Promise<boolean> {
  if (!url.pathname.startsWith('/api/roles')) return false
  if (!allowed(t)) return send(res, 403, { error: 'You do not have permission to manage roles' }), true

  if (req.method === 'GET' && url.pathname === '/api/roles') return send(res, 200, await payload(db, t.businessId)), true

  if (req.method === 'POST' && url.pathname === '/api/roles') {
    const x = await read(req), name = String(x.name || '').trim()
    if (name.length < 2) return send(res, 400, { error: 'Role name must contain at least 2 characters' }), true
    const code = String(x.code || name).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')
    const exists = await db.prepare('SELECT 1 FROM roles WHERE business_id=? AND (code=? OR lower(name)=lower(?))').get(t.businessId, code, name)
    if (exists) return send(res, 409, { error: 'A role with this name already exists' }), true
    const id = randomUUID()
    await db.prepare('INSERT INTO roles(id,business_id,code,name,is_system,created_at) VALUES(?,?,?,?,false,NOW())').run(id, t.businessId, code, name)
    for (const permCode of (Array.isArray(x.permissions) ? x.permissions : [])) {
      const p = await db.prepare('SELECT id FROM permissions WHERE code=?').get(permCode)
      if (p) await db.prepare('INSERT INTO role_permissions(role_id,permission_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(id, p.id)
    }
    await db.prepare('INSERT INTO audit_logs(id,business_id,branch_id,user_id,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,?,?,?,?,?,NOW())').run(randomUUID(), t.businessId, t.branchId, t.userId, 'ROLE_CREATED', 'role', id, JSON.stringify({ name, code }))
    return send(res, 201, { id }), true
  }

  const match = url.pathname.match(/^\/api\/roles\/([^/]+)$/)
  if (match && req.method === 'PATCH') {
    const role = await db.prepare('SELECT * FROM roles WHERE id=? AND business_id=?').get(match[1], t.businessId)
    if (!role) return send(res, 404, { error: 'Role not found' }), true
    if (role.code === 'BUSINESS_OWNER') return send(res, 409, { error: 'Business Owner permissions cannot be reduced' }), true
    const x = await read(req), codes = [...new Set(Array.isArray(x.permissions) ? x.permissions : [])] as string[]
    const valid = await db.prepare(`SELECT id,code FROM permissions WHERE code LIKE '%.%'`).all()
    const ids = valid.filter((p: any) => codes.includes(p.code))
    await db.transaction(async (tx: any) => {
      await tx.prepare('DELETE FROM role_permissions WHERE role_id=?').run(role.id)
      for (const p of ids) await tx.prepare('INSERT INTO role_permissions(role_id,permission_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(role.id, p.id)
      await tx.prepare('INSERT INTO audit_logs(id,business_id,branch_id,user_id,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,?,?,?,?,?,NOW())').run(randomUUID(), t.businessId, t.branchId, t.userId, 'ROLE_PERMISSIONS_UPDATED', 'role', role.id, JSON.stringify({ permissions: codes }))
    })
    return send(res, 200, { updated: true }), true
  }

  if (match && req.method === 'DELETE') {
    const role = await db.prepare('SELECT * FROM roles WHERE id=? AND business_id=?').get(match[1], t.businessId)
    if (!role) return send(res, 404, { error: 'Role not found' }), true
    if (role.is_system) return send(res, 409, { error: 'System roles cannot be deleted' }), true
    const inUse = await db.prepare('SELECT 1 FROM business_users WHERE business_id=? AND role_id=?').get(t.businessId, role.id)
    if (inUse) return send(res, 409, { error: 'Reassign users before deleting this role' }), true
    await db.prepare('DELETE FROM role_permissions WHERE role_id=?').run(role.id)
    await db.prepare('DELETE FROM roles WHERE id=? AND business_id=?').run(role.id, t.businessId)
    return send(res, 200, { deleted: true }), true
  }

  return false
}
