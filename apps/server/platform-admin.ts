// @ts-nocheck
import { randomUUID } from 'node:crypto'
import { createPlatformAccount } from './auth.ts'

const send = (res: any, s: number, v: any) => { const t = JSON.stringify(v); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(t) }); res.end(t) }
const body = async (req: any) => { let r = ''; for await (const c of req) r += c; return r ? JSON.parse(r) : {} }
const audit = async (db: any, user: any, action: string, type: string, id: string | null, details: any = {}) =>
  db.prepare('INSERT INTO platform_audit_logs(id,actor,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,?,?,?,NOW())').run(randomUUID(), user?.id || 'system', action, type, id || null, JSON.stringify(details))

export async function initializePlatformAdmin(db: any): Promise<void> {
  // Tables already created by schema.sql — just seed default settings
  for (const [k, v] of Object.entries({ platformName: 'Zentro Business Management', supportEmail: 'support@zentro.rw', defaultTrialDays: '14', maintenanceMode: 'false', allowNewRegistrations: 'true' })) {
    await db.prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,NOW()) ON CONFLICT(key) DO NOTHING').run(k, v)
  }
}

async function dashboard(db: any): Promise<any> {
  const businesses = await db.prepare('SELECT * FROM businesses').all()
  const subscriptions = await db.prepare('SELECT * FROM subscriptions').all()
  const active = subscriptions.filter((x: any) => x.status === 'ACTIVE')
  const mrrRow = await db.prepare("SELECT COALESCE(SUM(p.monthly_price),0) AS value FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.status='ACTIVE'").get()
  const newBizRow = await db.prepare("SELECT COUNT(*) AS value FROM businesses WHERE created_at>=NOW()-INTERVAL '30 days'").get()
  const activeUsersRow = await db.prepare("SELECT COUNT(DISTINCT user_id) AS value FROM auth_sessions WHERE revoked_at IS NULL AND refresh_expires_at>NOW()").get()
  const apiUsageRow = await db.prepare("SELECT COUNT(*) AS value FROM audit_logs WHERE created_at>=NOW()-INTERVAL '30 days'").get()
  const failedPayRow = await db.prepare("SELECT COUNT(*) AS value FROM subscription_payments WHERE status='FAILED'").get()
  const supportRow = await db.prepare("SELECT COUNT(*) AS value FROM support_requests WHERE status NOT IN ('RESOLVED','CLOSED')").get()
  const dbSizeRow = await db.prepare('SELECT pg_database_size(current_database()) AS size_bytes').get().catch(() => ({ size_bytes: 0 }))
  const moduleAdoption = await db.prepare(`SELECT m.code,m.name,COUNT(CASE WHEN a.enabled=true THEN 1 END) AS businesses,ROUND(100.0*COUNT(CASE WHEN a.enabled=true THEN 1 END)/GREATEST((SELECT COUNT(*) FROM businesses),1),1) AS adoption FROM business_modules m LEFT JOIN business_module_assignments a ON a.module_id=m.id GROUP BY m.id ORDER BY businesses DESC`).all()
  const recentBusinesses = await db.prepare(`SELECT b.id,b.name,b.status,b.created_at,p.name AS plan_name,COALESCE(u.name,'Unassigned') AS owner_name FROM businesses b LEFT JOIN subscriptions s ON s.id=(SELECT id FROM subscriptions WHERE business_id=b.id ORDER BY starts_at DESC LIMIT 1) LEFT JOIN subscription_plans p ON p.id=s.plan_id LEFT JOIN business_users bu ON bu.id=(SELECT bu2.id FROM business_users bu2 JOIN roles r2 ON r2.id=bu2.role_id WHERE bu2.business_id=b.id AND r2.code='BUSINESS_OWNER' LIMIT 1) LEFT JOIN users u ON u.id=bu.user_id ORDER BY b.created_at DESC LIMIT 6`).all()
  const recentTransactions = await db.prepare(`SELECT sp.id,sp.amount,sp.status,sp.provider,sp.created_at,b.name AS business,p.name AS plan_name FROM subscription_payments sp LEFT JOIN subscriptions s ON s.id=sp.subscription_id LEFT JOIN businesses b ON b.id=s.business_id LEFT JOIN subscription_plans p ON p.id=s.plan_id ORDER BY sp.created_at DESC LIMIT 6`).all()
  const planDistribution = await db.prepare(`SELECT p.name,COUNT(s.id) AS businesses,COALESCE(SUM(p.monthly_price),0) AS revenue FROM subscription_plans p LEFT JOIN subscriptions s ON s.plan_id=p.id AND s.status IN ('ACTIVE','TRIAL') WHERE p.is_active=true GROUP BY p.id ORDER BY businesses DESC`).all()
  const paymentSummary = await db.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN status IN ('SUCCESS','COMPLETED','PAID') THEN 1 ELSE 0 END),0) AS successful,COALESCE(SUM(CASE WHEN status='PENDING' THEN 1 ELSE 0 END),0) AS pending,COALESCE(SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END),0) AS failed,COALESCE(SUM(CASE WHEN status IN ('SUCCESS','COMPLETED','PAID') THEN amount ELSE 0 END),0) AS revenue FROM subscription_payments`).get()
  const series = []
  for (let offset = 5; offset >= 0; offset--) {
    const date = new Date(); date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() - offset)
    const key = date.toISOString().slice(0, 7), label = date.toLocaleDateString('en', { month: 'short' })
    const row = await db.prepare(`SELECT COUNT(*) AS businesses,COALESCE(SUM(CASE WHEN status IN ('ACTIVE','TRIAL') THEN 1 ELSE 0 END),0) AS active FROM businesses WHERE TO_CHAR(created_at,'YYYY-MM')=?`).get(key)
    const revRow = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS value FROM subscription_payments WHERE TO_CHAR(created_at,'YYYY-MM')=? AND status IN ('SUCCESS','COMPLETED','PAID')`).get(key)
    series.push({ key, label, businesses: row.businesses, active: row.active, revenue: revRow.value })
  }
  return { totalBusinesses: businesses.length, activeSubscriptions: active.length, trialBusinesses: businesses.filter((x: any) => x.status === 'TRIAL').length, suspendedAccounts: businesses.filter((x: any) => x.status === 'SUSPENDED').length, expiredSubscriptions: subscriptions.filter((x: any) => x.status === 'EXPIRED').length, mrr: mrrRow.value, arr: mrrRow.value * 12, newBusinesses: newBizRow.value, churnRate: businesses.length ? Number((businesses.filter((x: any) => x.status === 'SUSPENDED').length / businesses.length * 100).toFixed(1)) : 0, moduleAdoption, storageBytes: Number(dbSizeRow?.size_bytes || 0), apiUsage: apiUsageRow.value, activeUsers: activeUsersRow.value, failedPayments: failedPayRow.value, supportRequests: supportRow.value, recentBusinesses, recentTransactions, planDistribution, paymentSummary, series }
}

export async function handlePlatformAdmin(req: any, res: any, url: any, db: any, user: any): Promise<boolean> {
  const path = url.pathname

  if (req.method === 'GET' && path === '/api/platform/dashboard') return send(res, 200, await dashboard(db)), true

  if (req.method === 'GET' && path === '/api/platform/subscriptions')
    return send(res, 200, await db.prepare(`SELECT s.*,b.name AS business,b.owner_email,b.created_at AS joined_on,p.name AS plan,p.monthly_price,p.user_limit,p.branch_limit,(SELECT COUNT(*) FROM business_users bu WHERE bu.business_id=b.id AND bu.status='ACTIVE') AS user_count,CASE WHEN s.ends_at IS NOT NULL THEN s.ends_at ELSE s.starts_at+INTERVAL '1 month' END AS next_billing_date,'MONTHLY' AS billing_cycle FROM subscriptions s JOIN businesses b ON b.id=s.business_id JOIN subscription_plans p ON p.id=s.plan_id ORDER BY s.starts_at DESC`).all()), true

  if (req.method === 'POST' && path === '/api/platform/subscriptions') {
    const x = await body(req), business = await db.prepare('SELECT * FROM businesses WHERE id=?').get(x.businessId), plan = await db.prepare('SELECT * FROM subscription_plans WHERE id=? AND is_active=true').get(x.planId)
    if (!business || !plan) return send(res, 400, { error: 'A valid business and active plan are required' }), true
    const current = await db.prepare('SELECT * FROM subscriptions WHERE business_id=? ORDER BY starts_at DESC LIMIT 1').get(business.id), status = x.status || 'ACTIVE'
    if (current) await db.prepare('UPDATE subscriptions SET plan_id=?,status=?,starts_at=NOW(),ends_at=? WHERE id=?').run(plan.id, status, x.endsAt || null, current.id)
    else await db.prepare('INSERT INTO subscriptions(id,business_id,plan_id,status,starts_at,ends_at) VALUES(?,?,?,?,NOW(),?)').run(randomUUID(), business.id, plan.id, status, x.endsAt || null)
    await db.prepare('UPDATE businesses SET status=? WHERE id=?').run(status === 'ACTIVE' ? 'ACTIVE' : status, business.id)
    await audit(db, user, 'CREATE_SUBSCRIPTION', 'business', business.id, { planId: plan.id, status })
    return send(res, 201, { ok: true }), true
  }

  const subscription = path.match(/^\/api\/platform\/subscriptions\/([^/]+)$/)
  if (req.method === 'PATCH' && subscription) {
    const x = await body(req), current = await db.prepare('SELECT * FROM subscriptions WHERE id=?').get(subscription[1])
    if (!current) return send(res, 404, { error: 'Subscription not found' }), true
    const plan = x.planId ? await db.prepare('SELECT id FROM subscription_plans WHERE id=? AND is_active=true').get(x.planId) : null
    if (x.planId && !plan) return send(res, 400, { error: 'Plan is not active' }), true
    const status = x.status || current.status
    let endsAt = x.endsAt === undefined ? current.ends_at : (x.endsAt || null)
    if (x.endsAt === undefined && status === 'ACTIVE' && endsAt && new Date(endsAt) < new Date()) endsAt = null
    await db.prepare('UPDATE subscriptions SET plan_id=?,status=?,ends_at=? WHERE id=?').run(plan?.id || current.plan_id, status, endsAt, current.id)
    if (['ACTIVE', 'TRIAL', 'SUSPENDED'].includes(x.status)) await db.prepare('UPDATE businesses SET status=? WHERE id=?').run(x.status, current.business_id)
    await audit(db, user, 'UPDATE_SUBSCRIPTION', 'subscription', current.id, x)
    return send(res, 200, { ok: true }), true
  }

  if (req.method === 'GET' && path === '/api/platform/trials')
    return send(res, 200, await db.prepare(`SELECT b.*,t.name AS type_name,EXTRACT(EPOCH FROM NOW()-b.created_at)/86400 AS age_days FROM businesses b JOIN business_types t ON t.id=b.business_type_id WHERE b.status='TRIAL' ORDER BY b.created_at DESC`).all()), true

  const trial = path.match(/^\/api\/platform\/trials\/([^/]+)\/(convert|extend)$/)
  if (req.method === 'POST' && trial) {
    const x = await body(req), business = await db.prepare("SELECT * FROM businesses WHERE id=? AND status IN ('TRIAL','SUSPENDED')").get(trial[1])
    if (!business) return send(res, 404, { error: 'Trial business not found' }), true
    const sub = await db.prepare('SELECT * FROM subscriptions WHERE business_id=? ORDER BY starts_at DESC LIMIT 1').get(business.id)
    if (trial[2] === 'convert') {
      const plan = x.planId ? await db.prepare('SELECT * FROM subscription_plans WHERE id=? AND is_active=true').get(x.planId) : null
      if (x.planId && !plan) return send(res, 400, { error: 'Plan not found' }), true
      await db.prepare("UPDATE businesses SET status='ACTIVE' WHERE id=?").run(business.id)
      await db.prepare("UPDATE subscriptions SET status='ACTIVE',plan_id=?,ends_at=NULL WHERE id=?").run(plan?.id || sub.plan_id, sub.id)
    } else {
      const days = Math.min(Math.max(Number(x.days) || 14, 1), 90)
      const base = sub.ends_at && new Date(sub.ends_at) > new Date() ? new Date(sub.ends_at) : new Date()
      base.setDate(base.getDate() + days)
      await db.prepare("UPDATE subscriptions SET status='TRIAL',ends_at=? WHERE id=?").run(base.toISOString(), sub.id)
      await db.prepare("UPDATE businesses SET status='TRIAL' WHERE id=?").run(business.id)
    }
    await audit(db, user, trial[2].toUpperCase() + '_TRIAL', 'business', business.id, x)
    return send(res, 200, { ok: true }), true
  }

  if (req.method === 'GET' && path === '/api/platform/users')
    return send(res, 200, await db.prepare(`SELECT u.id,u.name,u.email,u.phone,u.user_type,u.platform_role,u.status,u.email_verified_at,u.must_change_password,u.created_at,COUNT(bu.id) AS memberships,COALESCE(MAX(r.name),REPLACE(COALESCE(u.platform_role,'User'),'_',' ')) AS role,COALESCE(MAX(b.name),'Zentro Platform') AS business,COALESCE(MIN(bu.joined_at),u.created_at) AS joined_on,(SELECT MAX(s.last_used_at) FROM auth_sessions s WHERE s.user_id=u.id) AS last_active FROM users u LEFT JOIN business_users bu ON bu.user_id=u.id LEFT JOIN roles r ON r.id=bu.role_id LEFT JOIN businesses b ON b.id=bu.business_id GROUP BY u.id ORDER BY u.created_at DESC`).all()), true

  if (req.method === 'POST' && path === '/api/platform/users') {
    const x = await body(req)
    try {
      const account = await createPlatformAccount(db, x)
      await audit(db, user, 'CREATE_PLATFORM_USER', 'user', account.id, { email: x.email, role: x.role })
      return send(res, 201, account), true
    } catch (error: any) { return send(res, 409, { error: error.message || 'Could not create user' }), true }
  }

  const platformUser = path.match(/^\/api\/platform\/users\/([^/]+)$/)
  if (req.method === 'PATCH' && platformUser) {
    const x = await body(req), current = await db.prepare('SELECT * FROM users WHERE id=?').get(platformUser[1])
    if (!current) return send(res, 404, { error: 'User not found' }), true
    if (current.id === user.id && ['SUSPENDED', 'DISABLED'].includes(x.status)) return send(res, 409, { error: 'You cannot disable your own account' }), true
    const status = x.status ?? current.status, role = x.role ?? current.platform_role
    await db.prepare('UPDATE users SET name=?,phone=?,status=?,platform_role=?,email_verified_at=?,updated_at=NOW() WHERE id=?').run(x.name ?? current.name, x.phone === undefined ? current.phone : (x.phone || null), status, role, x.verified === undefined ? current.email_verified_at : (x.verified ? new Date().toISOString() : null), current.id)
    if (['SUSPENDED', 'DISABLED'].includes(status)) await db.prepare('UPDATE auth_sessions SET revoked_at=NOW() WHERE user_id=? AND revoked_at IS NULL').run(current.id)
    await audit(db, user, 'UPDATE_PLATFORM_USER', 'user', current.id, x)
    return send(res, 200, { ok: true }), true
  }

  if (req.method === 'GET' && path === '/api/platform/revenue')
    return send(res, 200, { summary: await dashboard(db), payments: await db.prepare(`SELECT sp.*,b.name AS business FROM subscription_payments sp LEFT JOIN subscriptions s ON s.id=sp.subscription_id LEFT JOIN businesses b ON b.id=s.business_id ORDER BY sp.created_at DESC LIMIT 100`).all(), plans: await db.prepare(`SELECT p.name,p.monthly_price,COUNT(s.id) AS subscribers,COALESCE(SUM(CASE WHEN s.status='ACTIVE' THEN p.monthly_price ELSE 0 END),0) AS mrr FROM subscription_plans p LEFT JOIN subscriptions s ON s.plan_id=p.id GROUP BY p.id ORDER BY p.monthly_price`).all() }), true

  if (req.method === 'GET' && path === '/api/platform/usage') {
    const dbSize = Number((await db.prepare('SELECT pg_database_size(current_database()) AS s').get().catch(() => ({ s: 0 })))?.s || 0)
    return send(res, 200, { ...(await dashboard(db)), storageBytes: dbSize, branches: (await db.prepare('SELECT COUNT(*) AS value FROM branches').get()).value, warehouses: (await db.prepare('SELECT COUNT(*) AS value FROM warehouses').get()).value, sessions: (await db.prepare('SELECT COUNT(*) AS value FROM auth_sessions WHERE revoked_at IS NULL').get()).value }), true
  }

  if (req.method === 'GET' && path === '/api/platform/announcements') {
    const reach = { ALL: (await db.prepare('SELECT COUNT(*) AS n FROM businesses').get()).n, TRIALS: (await db.prepare("SELECT COUNT(*) AS n FROM businesses WHERE status='TRIAL'").get()).n, ACTIVE: (await db.prepare("SELECT COUNT(*) AS n FROM businesses WHERE status='ACTIVE'").get()).n }
    const rows = (await db.prepare('SELECT a.*,u.name AS created_by_name FROM platform_announcements a LEFT JOIN users u ON u.id=a.created_by ORDER BY a.created_at DESC').all()).map((x: any) => ({ ...x, reach: reach[x.audience as keyof typeof reach] ?? reach.ALL }))
    return send(res, 200, rows), true
  }

  if (req.method === 'POST' && path === '/api/platform/announcements') {
    const x = await body(req)
    if (!x.title || !x.message) return send(res, 400, { error: 'Title and message are required' }), true
    const id = randomUUID(), scheduledFor = x.scheduledFor ? new Date(x.scheduledFor).toISOString() : null
    if (x.scheduledFor && Number.isNaN(new Date(x.scheduledFor).getTime())) return send(res, 400, { error: 'Invalid schedule date' }), true
    const publishedAt = x.publish ? (scheduledFor || new Date().toISOString()) : null
    await db.prepare('INSERT INTO platform_announcements(id,title,message,audience,status,published_at,created_at,type,expires_at,created_by) VALUES(?,?,?,?,?,?,NOW(),?,?,?)').run(id, x.title, x.message, x.audience || 'ALL', x.publish ? 'PUBLISHED' : 'DRAFT', publishedAt, x.type || 'GENERAL', x.expiresAt ? new Date(x.expiresAt).toISOString() : null, user.id)
    await audit(db, user, 'CREATE_ANNOUNCEMENT', 'announcement', id, { title: x.title })
    return send(res, 201, { id }), true
  }

  const announcement = path.match(/^\/api\/platform\/announcements\/([^/]+)$/)
  if (req.method === 'PATCH' && announcement) {
    const x = await body(req), current = await db.prepare('SELECT * FROM platform_announcements WHERE id=?').get(announcement[1])
    if (!current) return send(res, 404, { error: 'Announcement not found' }), true
    const status = x.status || current.status
    await db.prepare('UPDATE platform_announcements SET title=?,message=?,audience=?,status=?,published_at=?,type=?,expires_at=? WHERE id=?').run(x.title ?? current.title, x.message ?? current.message, x.audience ?? current.audience, status, status === 'PUBLISHED' ? (current.published_at || new Date().toISOString()) : null, x.type ?? current.type, x.expiresAt !== undefined ? (x.expiresAt ? new Date(x.expiresAt).toISOString() : null) : current.expires_at, current.id)
    await audit(db, user, 'UPDATE_ANNOUNCEMENT', 'announcement', current.id, x)
    return send(res, 200, { ok: true }), true
  }
  if (req.method === 'DELETE' && announcement) {
    const result = await db.prepare('DELETE FROM platform_announcements WHERE id=?').run(announcement[1])
    if (result.changes) await audit(db, user, 'DELETE_ANNOUNCEMENT', 'announcement', announcement[1])
    return send(res, result.changes ? 200 : 404, result.changes ? { ok: true } : { error: 'Announcement not found' }), true
  }

  if (req.method === 'GET' && path === '/api/platform/support') {
    await db.prepare("UPDATE support_access_sessions SET status='EXPIRED' WHERE status='ACTIVE' AND expires_at<NOW()").run()
    return send(res, 200, { requests: await db.prepare(`SELECT r.*,b.name AS business,ru.name AS requested_by_name FROM support_requests r LEFT JOIN businesses b ON b.id=r.business_id LEFT JOIN users ru ON ru.id=r.requested_by ORDER BY r.created_at DESC`).all(), access: await db.prepare(`SELECT a.*,b.name AS business,u.name AS superadmin FROM support_access_sessions a JOIN businesses b ON b.id=a.business_id JOIN users u ON u.id=a.superadmin_user_id ORDER BY a.created_at DESC`).all() }), true
  }

  if (req.method === 'POST' && path === '/api/platform/support/access') {
    const x = await body(req)
    if (!x.businessId || !x.reason) return send(res, 400, { error: 'Business and support reason are required' }), true
    const id = randomUUID(), created = new Date(), expires = new Date(created.getTime() + Math.min(Math.max(Number(x.minutes) || 30, 5), 120) * 60000)
    await db.prepare('INSERT INTO support_access_sessions(id,business_id,superadmin_user_id,reason,status,expires_at,created_at,revoked_at,request_id) VALUES(?,?,?,?,?,?,NOW(),NULL,?)').run(id, x.businessId, user.id, x.reason, 'ACTIVE', expires.toISOString(), x.requestId || null)
    await audit(db, user, 'GRANT_SUPPORT_ACCESS', 'business', x.businessId, { reason: x.reason, minutes: x.minutes })
    return send(res, 201, { id, expiresAt: expires.toISOString() }), true
  }

  const requestItem = path.match(/^\/api\/platform\/support\/requests\/([^/]+)$/)
  if (req.method === 'PATCH' && requestItem) {
    const x = await body(req), current = await db.prepare('SELECT * FROM support_requests WHERE id=?').get(requestItem[1])
    if (!current) return send(res, 404, { error: 'Support request not found' }), true
    const status = x.status || 'IN_PROGRESS'
    await db.prepare('UPDATE support_requests SET status=?,resolved_at=?,resolution_note=? WHERE id=?').run(status, ['RESOLVED', 'CLOSED'].includes(status) ? new Date().toISOString() : null, x.resolutionNote ?? current.resolution_note, requestItem[1])
    await audit(db, user, 'UPDATE_SUPPORT_REQUEST', 'support_request', requestItem[1], x)
    return send(res, 200, { ok: true }), true
  }

  const supportRevoke = url.pathname.match(/^\/api\/platform\/support\/access\/([^/]+)\/revoke$/)
  if (req.method === 'POST' && supportRevoke) {
    const result = await db.prepare("UPDATE support_access_sessions SET status='REVOKED',revoked_at=NOW() WHERE id=? AND status='ACTIVE'").run(supportRevoke[1])
    return send(res, result.changes ? 200 : 404, result.changes ? { ok: true } : { error: 'Active support session not found' }), true
  }

  if (req.method === 'GET' && path === '/api/platform/audit-logs') {
    const tenant = await db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 250').all()
    const platform = await db.prepare(`SELECT id,created_at,action,entity_type,entity_id,actor AS user_id,NULL AS business_id,NULL AS branch_id,NULL AS ip_address,details FROM platform_audit_logs ORDER BY created_at DESC LIMIT 250`).all()
    return send(res, 200, [...tenant, ...platform].sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 250)), true
  }

  if (req.method === 'GET' && path === '/api/platform/feature-flags')
    return send(res, 200, await db.prepare(`SELECT f.*,COUNT(CASE WHEN bf.enabled=true THEN 1 END) AS enabled_businesses FROM feature_flags f LEFT JOIN business_feature_flags bf ON bf.feature_flag_id=f.id GROUP BY f.id ORDER BY f.name`).all()), true

  const flag = url.pathname.match(/^\/api\/platform\/feature-flags\/([^/]+)$/)
  if (req.method === 'PATCH' && flag) {
    const x = await body(req), result = await db.prepare('UPDATE feature_flags SET enabled=? WHERE id=?').run(Boolean(x.enabled), flag[1])
    return send(res, result.changes ? 200 : 404, result.changes ? { ok: true } : { error: 'Feature flag not found' }), true
  }

  if (req.method === 'GET' && path === '/api/platform/exports')
    return send(res, 200, await db.prepare('SELECT * FROM platform_exports ORDER BY created_at DESC').all()), true

  if (req.method === 'POST' && path === '/api/platform/exports') {
    const x = await body(req), id = randomUUID()
    await db.prepare('INSERT INTO platform_exports(id,type,status,requested_by,created_at,completed_at,file_name) VALUES(?,?,?,?,NOW(),NOW(),?)').run(id, x.type || 'BUSINESSES', 'READY', user.id, `zentro-${String(x.type || 'businesses').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`)
    return send(res, 201, { id, status: 'READY' }), true
  }

  const exportDownload = path.match(/^\/api\/platform\/exports\/([^/]+)\/download$/)
  if (req.method === 'GET' && exportDownload) {
    const job = await db.prepare('SELECT * FROM platform_exports WHERE id=?').get(exportDownload[1])
    if (!job) return send(res, 404, { error: 'Export not found' }), true
    const rows = job.type === 'USERS'
      ? await db.prepare('SELECT id,name,email,phone,user_type,status,created_at FROM users').all()
      : await db.prepare(`SELECT b.id,b.name,b.slug,t.name AS business_type,b.owner_name,b.owner_email,b.status,b.currency,b.country,b.created_at FROM businesses b JOIN business_types t ON t.id=b.business_type_id`).all()
    const headers = rows.length ? Object.keys(rows[0]) : []
    const esc = (v: any) => '"' + String(v ?? '').replaceAll('"', '""') + '"'
    const csv = [headers.map(esc).join(','), ...rows.map((r: any) => headers.map(h => esc(r[h])).join(','))].join('\r\n')
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${job.file_name}"`, 'content-length': Buffer.byteLength(csv) })
    res.end(csv)
    await audit(db, user, 'DOWNLOAD_EXPORT', 'export', job.id, { type: job.type })
    return true
  }

  if (req.method === 'GET' && path === '/api/platform/system-settings') {
    const latest = await db.prepare(`SELECT c.created_at,u.name AS updated_by FROM platform_setting_changes c LEFT JOIN users u ON u.id=c.updated_by ORDER BY c.created_at DESC LIMIT 1`).get()
    return send(res, 200, { values: Object.fromEntries((await db.prepare('SELECT key,value FROM platform_settings').all()).map((x: any) => [x.key, x.value])), meta: { lastUpdated: latest?.created_at || null, updatedBy: latest?.updated_by || 'System' }, history: await db.prepare(`SELECT c.*,u.name AS updated_by_name FROM platform_setting_changes c LEFT JOIN users u ON u.id=c.updated_by ORDER BY c.created_at DESC LIMIT 30`).all() }), true
  }

  if (req.method === 'POST' && path === '/api/platform/system-settings') {
    const x = await body(req), reason = String(x.reason || 'Platform configuration update').trim()
    const values = x.values && typeof x.values === 'object' ? x.values : Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'reason'))
    if (!reason) return send(res, 400, { error: 'Reason for change is required' }), true
    await db.transaction(async (tx: any) => {
      for (const [k, v] of Object.entries(values)) {
        const previous = (await tx.prepare('SELECT value FROM platform_settings WHERE key=?').get(k))?.value ?? null
        const next = String(v)
        if (previous !== next) {
          await tx.prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()').run(k, next)
          await tx.prepare('INSERT INTO platform_setting_changes(id,setting_key,previous_value,new_value,reason,updated_by,created_at) VALUES(?,?,?,?,?,?,NOW())').run(randomUUID(), k, previous, next, reason, user.id)
        }
      }
    })
    await audit(db, user, 'UPDATE_SYSTEM_SETTINGS', 'platform_settings', null, { keys: Object.keys(values), reason })
    return send(res, 200, { ok: true, updatedAt: new Date().toISOString() }), true
  }

  return false
}
