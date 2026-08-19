// @ts-nocheck
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'

const json = async req => { let raw = ''; for await (const chunk of req) raw += chunk; return raw ? JSON.parse(raw) : {} }
const send = (res, status, value, headers: any = {}) => { const body = JSON.stringify(value); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers }); res.end(body) }
const cookie = (req, name) => { const found = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`)); return found ? decodeURIComponent(found.slice(name.length + 1)) : null }
const passwordHash = (password, salt) => scryptSync(password, salt, 64).toString('hex')
const tokenHash = token => createHash('sha256').update(token).digest('hex')
const now = () => new Date()
const addTime = (date, ms) => new Date(date.getTime() + ms)
const crossOrigin = Boolean(process.env.CORS_ORIGIN)
const sameSite = crossOrigin ? 'None' : 'Strict'
const secure = (process.env.NODE_ENV === 'production' || crossOrigin) ? '; Secure' : ''
const portal = req => String(req.headers['x-zentro-portal'] || '').toLowerCase() === 'superadmin' || String(req.url || '').startsWith('/api/platform') ? 'platform' : 'business'
const cookieNames = scope => scope === 'PLATFORM' ? { access: 'zentro_platform_session', refresh: 'zentro_platform_refresh' } : { access: 'zentro_business_session', refresh: 'zentro_business_refresh' }
const accessCookie = req => cookie(req, cookieNames(portal(req) === 'platform' ? 'PLATFORM' : 'BUSINESS').access)
const refreshCookie = req => cookie(req, cookieNames(portal(req) === 'platform' ? 'PLATFORM' : 'BUSINESS').refresh)
export const sessionCookies = (access, refresh, scope) => { const names = cookieNames(scope); return [`${names.access}=${access}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=900${secure}`, `${names.refresh}=${refresh}; Path=/api/auth; HttpOnly; SameSite=${sameSite}; Max-Age=2592000${secure}`] }
const clearCookies = scope => { const names = cookieNames(scope || 'BUSINESS'); return [`${names.access}=; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0${secure}`, `${names.refresh}=; Path=/api/auth; HttpOnly; SameSite=${sameSite}; Max-Age=0${secure}`] }
const clearHeader = scope => ({ 'set-cookie': clearCookies(scope) })

export async function initializeAuth(db: any): Promise<void> {
  const salt = randomBytes(16).toString('hex')
  await db.prepare(`
    INSERT INTO users(id,email,name,status,created_at,password_hash,password_salt,user_type,platform_role,must_change_password)
    VALUES(?,?,?,'ACTIVE',NOW(),?,?,'PLATFORM','SUPERADMIN',true)
    ON CONFLICT(email) DO NOTHING
  `).run(randomUUID(), 'superadmin@zentro.rw', 'Platform Superadmin', passwordHash('Zentro@2026!', salt), salt)
}

async function memberships(db: any, userId: string): Promise<any[]> {
  const rows = await db.prepare(`
    SELECT bu.business_id AS "businessId", b.name AS "businessName", b.slug,
      t.code AS "businessTypeCode", r.id AS "roleId", r.code AS role,
      bu.default_branch_id AS "defaultBranchId", bu.status
    FROM business_users bu
    JOIN businesses b ON b.id=bu.business_id
    JOIN business_types t ON t.id=b.business_type_id
    JOIN roles r ON r.id=bu.role_id
    WHERE bu.user_id=? AND bu.status='ACTIVE'
      AND b.status IN ('ACTIVE','TRIAL')
      AND ((SELECT ends_at FROM subscriptions WHERE business_id=b.id ORDER BY starts_at DESC LIMIT 1) IS NULL
        OR (SELECT ends_at FROM subscriptions WHERE business_id=b.id ORDER BY starts_at DESC LIMIT 1) > NOW())
    ORDER BY b.name
  `).all(userId)
  for (const m of rows) {
    m.branches = await db.prepare("SELECT id,name,code FROM branches WHERE business_id=? AND status='ACTIVE' ORDER BY name").all(m.businessId)
  }
  return rows
}

async function publicUser(db: any, user: any, session: any): Promise<any> {
  const allMemberships = user.user_type === 'BUSINESS' ? await memberships(db, user.id) : []
  const active = allMemberships.find(x => x.businessId === session?.active_business_id) || allMemberships[0] || null
  const branchId = session?.active_branch_id || active?.defaultBranchId || active?.branches?.[0]?.id || null
  const permissions = active ? (await db.prepare('SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=?').all(active.roleId)).map((x: any) => x.code) : []
  const enabledModules = active ? (await db.prepare('SELECT m.code FROM business_module_assignments a JOIN business_modules m ON m.id=a.module_id WHERE a.business_id=? AND a.enabled=true').all(active.businessId)).map((x: any) => x.code) : []
  const businessLogo = active ? (await db.prepare("SELECT value FROM tenant_business_settings WHERE business_id=? AND key='logoUrl'").get(active.businessId))?.value || null : null
  return {
    id: user.id, email: user.email, phone: user.phone, name: user.name,
    scope: user.user_type, role: user.user_type === 'PLATFORM' ? user.platform_role : active?.role || null,
    businessId: active?.businessId || null, businessName: active?.businessName || null,
    businessTypeCode: active?.businessTypeCode || null, businessLogo, branchId,
    roleId: active?.roleId || null, permissions, enabledModules, memberships: allMemberships,
    emailVerified: Boolean(user.email_verified_at), phoneVerified: Boolean(user.phone_verified_at),
    mustChangePassword: Boolean(user.must_change_password),
  }
}

async function sessionRow(req: any, db: any): Promise<any> {
  const id = accessCookie(req)
  if (!id) return null
  const expected = portal(req) === 'platform' ? 'PLATFORM' : 'BUSINESS'
  return db.prepare(`
    SELECT s.id AS session_id, s.active_business_id, s.active_branch_id, s.expires_at,
      s.refresh_expires_at, s.device_name, s.ip_address, s.last_used_at, u.*
    FROM auth_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.id=? AND s.expires_at>NOW() AND s.revoked_at IS NULL
      AND u.status='ACTIVE' AND u.user_type=?
  `).get(id, expected)
}

export async function authenticate(req: any, db: any): Promise<any> {
  const row = await sessionRow(req, db)
  if (!row) return null
  await db.prepare('UPDATE auth_sessions SET last_used_at=NOW() WHERE id=?').run(row.session_id)
  return publicUser(db, row, row)
}

export const isSuperadmin = user => user?.scope === 'PLATFORM' && user?.role === 'SUPERADMIN'

export async function issueSession(req: any, db: any, user: any, activeBusinessId: any = null, activeBranchId: any = null, rotatedFrom: any = null): Promise<any> {
  const access = randomBytes(32).toString('hex')
  const refresh = randomBytes(48).toString('hex')
  const accessExpiry = addTime(now(), 15 * 60 * 1000)
  const refreshExpiry = addTime(now(), 30 * 24 * 60 * 60 * 1000)
  const allM = user.user_type === 'BUSINESS' ? await memberships(db, user.id) : []
  const member = allM.find(x => x.businessId === activeBusinessId) || allM[0] || null
  const businessId = member?.businessId || null
  const branchId = activeBranchId && member?.branches.some(x => x.id === activeBranchId) ? activeBranchId : member?.defaultBranchId || member?.branches?.[0]?.id || null
  await db.prepare(`
    INSERT INTO auth_sessions(id,user_id,expires_at,created_at,active_business_id,active_branch_id,
      refresh_token_hash,refresh_expires_at,device_name,ip_address,last_used_at,revoked_at,rotated_from)
    VALUES(?,?,?,NOW(),?,?,?,?,?,?,NOW(),NULL,?)
  `).run(access, user.id, accessExpiry.toISOString(), businessId, branchId, tokenHash(refresh), refreshExpiry.toISOString(), String(req.headers['user-agent'] || 'Unknown device').slice(0, 180), req.socket?.remoteAddress || null, rotatedFrom)
  const session = await db.prepare('SELECT * FROM auth_sessions WHERE id=?').get(access)
  return { access, refresh, user: await publicUser(db, user, session) }
}

export async function createBusinessOwnerAccount(db: any, { businessId, name, email, phone, password, branchId }: any): Promise<any> {
  const normalized = String(email).trim().toLowerCase()
  if (await db.prepare('SELECT 1 FROM users WHERE lower(email)=lower(?)').get(normalized)) throw new Error('An account with this email already exists')
  if (phone && await db.prepare('SELECT 1 FROM users WHERE phone=?').get(phone)) throw new Error('An account with this phone already exists')
  const id = randomUUID()
  const salt = randomBytes(16).toString('hex')
  const temporaryPassword = password || `Zentro@${randomBytes(4).toString('hex')}`
  const hash = passwordHash(temporaryPassword, salt)
  await db.prepare('INSERT INTO users(id,email,phone,name,status,created_at,password_hash,password_salt,user_type,must_change_password,updated_at) VALUES(?,?,?,?,\'ACTIVE\',NOW(),?,?,\'BUSINESS\',true,NOW())').run(id, normalized, phone || null, name, hash, salt)
  const role = await db.prepare("SELECT id FROM roles WHERE business_id=? AND code='BUSINESS_OWNER'").get(businessId)
  await db.prepare('INSERT INTO business_users(id,business_id,user_id,role_id,default_branch_id,status,created_at,joined_at,updated_at) VALUES(?,?,?,?,?,\'ACTIVE\',NOW(),NOW(),NOW())').run(randomUUID(), businessId, id, role.id, branchId)
  return { id, temporaryPassword }
}

export async function createPlatformAccount(db: any, { name, email, phone, password, role = 'PLATFORM_ADMIN', status = 'ACTIVE' }: any): Promise<any> {
  const normalized = String(email || '').trim().toLowerCase()
  if (!normalized || !name) throw new Error('Name and email are required')
  if (await db.prepare('SELECT 1 FROM users WHERE lower(email)=lower(?)').get(normalized)) throw new Error('An account with this email already exists')
  const id = randomUUID()
  const salt = randomBytes(16).toString('hex')
  const temporaryPassword = String(password || `Zentro@${randomBytes(4).toString('hex')}`)
  if (temporaryPassword.length < 10) throw new Error('Temporary password must contain at least 10 characters')
  const hash = passwordHash(temporaryPassword, salt)
  const safeRole = String(role || 'PLATFORM_ADMIN').toUpperCase()
  await db.prepare('INSERT INTO users(id,email,phone,name,status,created_at,password_hash,password_salt,user_type,platform_role,must_change_password,updated_at) VALUES(?,?,?,?,?,NOW(),?,?,\'PLATFORM\',?,true,NOW())').run(id, normalized, phone || null, String(name).trim(), status, hash, salt, safeRole)
  return { id, temporaryPassword }
}

export async function resetTemporaryPassword(db: any, userId: string, password: any): Promise<any> {
  const user = await db.prepare("SELECT * FROM users WHERE id=? AND user_type='BUSINESS'").get(userId)
  if (!user) throw new Error('Business user not found')
  const temporaryPassword = String(password || `Zentro@${randomBytes(4).toString('hex')}`)
  if (temporaryPassword.length < 10) throw new Error('Temporary password must contain at least 10 characters')
  const salt = randomBytes(16).toString('hex')
  const hash = passwordHash(temporaryPassword, salt)
  await db.prepare('UPDATE users SET password_hash=?,password_salt=?,must_change_password=true,status=\'ACTIVE\',updated_at=NOW() WHERE id=?').run(hash, salt, user.id)
  await db.prepare('UPDATE auth_sessions SET revoked_at=NOW() WHERE user_id=? AND revoked_at IS NULL').run(user.id)
  return { userId: user.id, email: user.email, temporaryPassword }
}

function businessAction(method: string, path: string): string {
  if (method === 'GET') return /\/(export|download)(\/|$)/.test(path) ? 'export' : 'view'
  if (method === 'DELETE') return 'delete'
  if (/\/(approve|reject|void|revoke|confirm|review|refund|close|publish|convert|restore)(\/|$)/.test(path)) return 'approve'
  if (/\/(submit|hold|cancel|resolve|dispatch|deliver|action|adjust)(\/|$)/.test(path)) return 'edit'
  return method === 'POST' ? 'create' : 'edit'
}

export function canAccessBusinessApi(req: any, url: any, user: any): boolean {
  if (user?.scope !== 'BUSINESS' || !user.businessId) return false
  if (user.role === 'BUSINESS_OWNER') return true
  const path = url.pathname
  const permissions = new Set(user.permissions || [])
  if (/^\/api\/notifications/.test(path)) return true
  if (/^\/api\/support-requests/.test(path)) return true
  const modules: [RegExp, string][] = [
    [/^\/api\/dashboard/, 'dashboard'],
    [/^\/api\/(orders|sales|invoices|returns|proforma|tables)/, 'sales'],
    [/^\/api\/customers/, 'customers'],
    [/^\/api\/(menu|products|categories)/, 'products'],
    [/^\/api\/(inventory|inventory-overview|stock-movements|warehouses|transfers)/, 'inventory'],
    [/^\/api\/(suppliers|purchase-orders)/, 'procurement'],
    [/^\/api\/expenses/, 'expenses'],
    [/^\/api\/accounting/, 'accounting'],
    [/^\/api\/cash-bank/, 'cash_bank'],
    [/^\/api\/(loans|subscription)/, 'loans'],
    [/^\/api\/(staff|roles)/, 'staff'],
    [/^\/api\/(reports|analytics)/, 'reports'],
    [/^\/api\/(settings|backups|system)/, 'settings'],
  ]
  const moduleCode = modules.find(([pattern]) => pattern.test(path))?.[1]
  return Boolean(moduleCode && permissions.has(`${moduleCode}.${businessAction(req.method, path)}`))
}

function verifyPassword(user: any, password: any): boolean {
  if (!user?.password_hash || !user?.password_salt) return false
  const calculated = Buffer.from(passwordHash(String(password || ''), user.password_salt), 'hex')
  const stored = Buffer.from(user.password_hash, 'hex')
  return calculated.length === stored.length && timingSafeEqual(calculated, stored)
}

function setSessionResponse(res: any, payload: any, status = 200): void {
  const cookies = sessionCookies(payload.access, payload.refresh, payload.user.scope)
  send(res, status, { user: payload.user }, { 'set-cookie': cookies })
}

export async function handleAuth(req: any, res: any, url: any, db: any): Promise<boolean> {
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const input = await json(req)
    const identifier = String(input.identifier || input.email || input.phone || '').trim()
    const user = await db.prepare('SELECT * FROM users WHERE lower(email)=lower(?) OR phone=?').get(identifier, identifier)
    if (!user || user.status !== 'ACTIVE' || !verifyPassword(user, input.password))
      return send(res, 401, { error: 'Invalid email, phone, or password' }), true
    if (input.portal === 'superadmin' && !(user.user_type === 'PLATFORM' && user.platform_role === 'SUPERADMIN'))
      return send(res, 403, { error: 'This account cannot access the Superadmin portal' }), true
    if (input.portal === 'business' && user.user_type !== 'BUSINESS')
      return send(res, 403, { error: 'Use the Superadmin portal for this account' }), true
    const payload = await issueSession(req, db, user, input.businessId, input.branchId)
    setSessionResponse(res, payload); return true
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/refresh') {
    const raw = refreshCookie(req), expected = portal(req) === 'platform' ? 'PLATFORM' : 'BUSINESS'
    if (!raw) return send(res, 401, { error: 'Refresh token required' }, clearHeader(expected)), true
    const session = await db.prepare(`SELECT s.id AS session_id,s.active_business_id,s.active_branch_id,u.* FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.refresh_token_hash=? AND s.refresh_expires_at>NOW() AND s.revoked_at IS NULL AND u.user_type=?`).get(tokenHash(raw), expected)
    if (!session) return send(res, 401, { error: 'Refresh token is invalid or expired' }, clearHeader(expected)), true
    await db.prepare('UPDATE auth_sessions SET revoked_at=NOW() WHERE id=?').run(session.session_id)
    const payload = await issueSession(req, db, session, session.active_business_id, session.active_branch_id, session.session_id)
    setSessionResponse(res, payload); return true
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/restore') {
    const raw = refreshCookie(req), expected = portal(req) === 'platform' ? 'PLATFORM' : 'BUSINESS'
    if (!raw) return send(res, 200, { user: null }), true
    const session = await db.prepare(`SELECT s.id AS session_id,s.active_business_id,s.active_branch_id,u.* FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.refresh_token_hash=? AND s.refresh_expires_at>NOW() AND s.revoked_at IS NULL AND u.status='ACTIVE' AND u.user_type=?`).get(tokenHash(raw), expected)
    if (!session) return send(res, 200, { user: null }, clearHeader(expected)), true
    await db.prepare('UPDATE auth_sessions SET revoked_at=NOW() WHERE id=?').run(session.session_id)
    const payload = await issueSession(req, db, session, session.active_business_id, session.active_branch_id, session.session_id)
    setSessionResponse(res, payload); return true
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const row = await sessionRow(req, db)
    return send(res, 200, { user: row ? await publicUser(db, row, row) : null }), true
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const id = accessCookie(req), expected = portal(req) === 'platform' ? 'PLATFORM' : 'BUSINESS'
    if (id) await db.prepare('UPDATE auth_sessions SET revoked_at=NOW() WHERE id=?').run(id)
    return send(res, 200, { ok: true }, { 'set-cookie': clearCookies(expected) }), true
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/sessions') {
    const current = await authenticate(req, db)
    if (!current) return send(res, 401, { error: 'Authentication required' }), true
    const activeId = accessCookie(req)
    return send(res, 200, await db.prepare(`SELECT id, device_name AS "deviceName", ip_address AS "ipAddress", created_at AS "createdAt", last_used_at AS "lastUsedAt", refresh_expires_at AS "refreshExpiresAt", CASE WHEN id=? THEN true ELSE false END AS current FROM auth_sessions WHERE user_id=? AND revoked_at IS NULL AND refresh_expires_at>NOW() ORDER BY last_used_at DESC`).all(activeId, current.id)), true
  }

  const device = url.pathname.match(/^\/api\/auth\/sessions\/([^/]+)$/)
  if (req.method === 'DELETE' && device) {
    const current = await authenticate(req, db)
    if (!current) return send(res, 401, { error: 'Authentication required' }), true
    const result = await db.prepare('UPDATE auth_sessions SET revoked_at=NOW() WHERE id=? AND user_id=?').run(device[1], current.id)
    return send(res, result.changes ? 200 : 404, result.changes ? { ok: true } : { error: 'Session not found' }, device[1] === accessCookie(req) ? clearHeader(current.scope) : {}), true
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout-all') {
    const current = await authenticate(req, db)
    if (!current) return send(res, 401, { error: 'Authentication required' }), true
    await db.prepare('UPDATE auth_sessions SET revoked_at=NOW() WHERE user_id=? AND revoked_at IS NULL').run(current.id)
    return send(res, 200, { ok: true }, clearHeader(current.scope)), true
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/switch-business') {
    const current = await authenticate(req, db), input = await json(req), session = await sessionRow(req, db)
    if (!current || !session) return send(res, 401, { error: 'Authentication required' }), true
    const member = (await memberships(db, current.id)).find(x => x.businessId === input.businessId)
    if (!member) return send(res, 403, { error: 'You do not belong to this business' }), true
    const branch = member.branches.find(x => x.id === input.branchId) || member.branches.find(x => x.id === member.defaultBranchId) || member.branches[0]
    await db.prepare('UPDATE auth_sessions SET active_business_id=?,active_branch_id=?,last_used_at=NOW() WHERE id=?').run(member.businessId, branch?.id || null, session.session_id)
    const updated = await db.prepare('SELECT * FROM auth_sessions WHERE id=?').get(session.session_id)
    return send(res, 200, { user: await publicUser(db, await db.prepare('SELECT * FROM users WHERE id=?').get(current.id), updated) }), true
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/switch-branch') {
    const current = await authenticate(req, db), input = await json(req), session = await sessionRow(req, db)
    if (!current || !session) return send(res, 401, { error: 'Authentication required' }), true
    const branch = await db.prepare("SELECT id FROM branches WHERE id=? AND business_id=? AND status='ACTIVE'").get(input.branchId, current.businessId)
    if (!branch) return send(res, 403, { error: 'Branch does not belong to the active business' }), true
    await db.prepare('UPDATE auth_sessions SET active_branch_id=?,last_used_at=NOW() WHERE id=?').run(branch.id, session.session_id)
    const updated = await db.prepare('SELECT * FROM auth_sessions WHERE id=?').get(session.session_id)
    return send(res, 200, { user: await publicUser(db, await db.prepare('SELECT * FROM users WHERE id=?').get(current.id), updated) }), true
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/change-password') {
    const current = await authenticate(req, db), input = await json(req)
    if (!current) return send(res, 401, { error: 'Authentication required' }), true
    const user = await db.prepare('SELECT * FROM users WHERE id=?').get(current.id)
    if (!verifyPassword(user, input.currentPassword)) return send(res, 400, { error: 'Current password is incorrect' }), true
    if (String(input.newPassword || '').length < 10) return send(res, 400, { error: 'New password must contain at least 10 characters' }), true
    const salt = randomBytes(16).toString('hex'), hash = passwordHash(input.newPassword, salt)
    await db.prepare('UPDATE users SET password_hash=?,password_salt=?,must_change_password=false,updated_at=NOW() WHERE id=?').run(hash, salt, user.id)
    await db.prepare('UPDATE auth_sessions SET revoked_at=NOW() WHERE user_id=? AND id<>? AND revoked_at IS NULL').run(user.id, accessCookie(req))
    return send(res, 200, { ok: true }), true
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/password-reset/request') {
    const input = await json(req), identifier = String(input.identifier || input.email || input.phone || '').trim()
    const user = await db.prepare('SELECT * FROM users WHERE lower(email)=lower(?) OR phone=?').get(identifier, identifier)
    let developmentToken: string | undefined
    if (user) {
      const raw = randomBytes(32).toString('hex'); developmentToken = raw
      await db.prepare('INSERT INTO password_reset_tokens(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,NOW())').run(randomUUID(), user.id, tokenHash(raw), addTime(now(), 30 * 60 * 1000).toISOString())
    }
    return send(res, 200, { ok: true, message: 'If the account exists, reset instructions have been generated.', ...(process.env.NODE_ENV !== 'production' && developmentToken ? { developmentToken } : {}) }), true
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/password-reset/confirm') {
    const input = await json(req)
    const token = await db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash=? AND expires_at>NOW() AND used_at IS NULL').get(tokenHash(String(input.token || '')))
    if (!token) return send(res, 400, { error: 'Reset token is invalid or expired' }), true
    if (String(input.newPassword || '').length < 10) return send(res, 400, { error: 'New password must contain at least 10 characters' }), true
    const salt = randomBytes(16).toString('hex'), hash = passwordHash(input.newPassword, salt)
    await db.prepare('UPDATE users SET password_hash=?,password_salt=?,must_change_password=false,updated_at=NOW() WHERE id=?').run(hash, salt, token.user_id)
    await db.prepare('UPDATE password_reset_tokens SET used_at=NOW() WHERE id=?').run(token.id)
    await db.prepare('UPDATE auth_sessions SET revoked_at=NOW() WHERE user_id=? AND revoked_at IS NULL').run(token.user_id)
    return send(res, 200, { ok: true }), true
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/verification/request') {
    const current = await authenticate(req, db), input = await json(req)
    if (!current) return send(res, 401, { error: 'Authentication required' }), true
    const channel = input.channel === 'phone' ? 'phone' : 'email'
    const user = await db.prepare('SELECT * FROM users WHERE id=?').get(current.id)
    if (channel === 'phone' && !user.phone) return send(res, 400, { error: 'No phone number is configured' }), true
    const raw = String(Math.floor(100000 + Math.random() * 900000))
    await db.prepare('INSERT INTO verification_tokens(id,user_id,channel,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,NOW())').run(randomUUID(), user.id, channel, tokenHash(raw), addTime(now(), 15 * 60 * 1000).toISOString())
    return send(res, 200, { ok: true, ...(process.env.NODE_ENV !== 'production' ? { developmentCode: raw } : {}) }), true
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/verification/confirm') {
    const current = await authenticate(req, db), input = await json(req)
    if (!current) return send(res, 401, { error: 'Authentication required' }), true
    const channel = input.channel === 'phone' ? 'phone' : 'email'
    const token = await db.prepare('SELECT * FROM verification_tokens WHERE user_id=? AND channel=? AND token_hash=? AND expires_at>NOW() AND used_at IS NULL ORDER BY created_at DESC LIMIT 1').get(current.id, channel, tokenHash(String(input.code || '')))
    if (!token) return send(res, 400, { error: 'Verification code is invalid or expired' }), true
    await db.prepare('UPDATE verification_tokens SET used_at=NOW() WHERE id=?').run(token.id)
    const col = channel === 'phone' ? 'phone_verified_at' : 'email_verified_at'
    await db.prepare(`UPDATE users SET ${col}=NOW(),updated_at=NOW() WHERE id=?`).run(current.id)
    return send(res, 200, { ok: true }), true
  }

  return false
}
