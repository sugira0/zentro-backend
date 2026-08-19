// @ts-nocheck
import { randomBytes, randomUUID } from 'node:crypto'
import { provisionBusinessTenant } from './tenant-core.ts'
import { issueSession, sessionCookies } from './auth.ts'

const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
const cookie = (req: any, name: string) => { const found = String(req.headers.cookie || '').split(';').map((x: string) => x.trim()).find((x: string) => x.startsWith(`${name}=`)); return found ? decodeURIComponent(found.slice(name.length + 1)) : null }
const redirect = (res: any, location: string, extraHeaders: any = {}) => { res.writeHead(302, { location, ...extraHeaders }); res.end() }
const failure = (res: any, message: string) => redirect(res, `/app?googleError=${encodeURIComponent(message)}`, { 'set-cookie': `zentro_google_state=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secure}` })
const slugify = (name: string) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'business'
const uniqueSlug = async (db: any, base: string) => { let slug = base, n = 1; while (await db.prepare('SELECT 1 FROM businesses WHERE slug=?').get(slug)) slug = `${base}-${++n}`; return slug }
const googleConfig = () => ({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, redirectUri: process.env.GOOGLE_REDIRECT_URI })

async function exchangeCode(code: string, config: any): Promise<any> {
  const body = new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: 'authorization_code' })
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
  if (!response.ok) throw new Error('Google could not verify this sign-in attempt')
  return response.json()
}

async function fetchProfile(accessToken: string): Promise<any> {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { authorization: `Bearer ${accessToken}` } })
  if (!response.ok) throw new Error('Unable to load your Google profile')
  return response.json()
}

async function createBusinessForGoogleUser(db: any, profile: any): Promise<any> {
  const type = await db.prepare("SELECT * FROM business_types WHERE code='general_distribution' AND is_active=true").get() || await db.prepare('SELECT * FROM business_types WHERE is_active=true ORDER BY name LIMIT 1').get()
  const plan = await db.prepare("SELECT * FROM subscription_plans WHERE code='starter' AND is_active=true").get() || await db.prepare('SELECT * FROM subscription_plans WHERE is_active=true LIMIT 1').get()
  if (!type || !plan) throw new Error('The platform is not ready to create new businesses yet')

  const businessId = randomUUID(), ownerName = profile.name || profile.email
  const name = `${profile.given_name || ownerName}'s Business`, slug = await uniqueSlug(db, slugify(name))
  const trialDaysRow = await db.prepare("SELECT value FROM platform_settings WHERE key='defaultTrialDays'").get().catch(() => null)
  const trialDays = Math.max(1, Number(trialDaysRow?.value) || 14)
  const trialEndsAt = new Date(Date.now() + trialDays * 86400000).toISOString()

  await db.transaction(async (tx: any) => {
    await tx.prepare('INSERT INTO businesses(id,name,slug,business_type_id,owner_name,owner_email,owner_phone,status,currency,country,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,NOW())').run(businessId, name, slug, type.id, ownerName, profile.email, '', 'TRIAL', 'RWF', 'Rwanda')
    await tx.prepare('INSERT INTO subscriptions(id,business_id,plan_id,status,starts_at,ends_at) VALUES(?,?,?,?,NOW(),?)').run(randomUUID(), businessId, plan.id, 'TRIAL', trialEndsAt)
    await tx.prepare('INSERT INTO business_module_assignments(business_id,module_id,enabled,assigned_at) SELECT ?,module_id,true,NOW() FROM business_type_modules WHERE business_type_id=? ON CONFLICT DO NOTHING').run(businessId, type.id)
  })

  const tenant = await provisionBusinessTenant(db, businessId, type.code)
  const userId = randomUUID(), salt = randomBytes(16).toString('hex'), unusablePassword = randomBytes(32).toString('hex')
  await db.prepare('INSERT INTO users(id,email,name,status,created_at,phone,password_hash,password_salt,user_type,must_change_password,email_verified_at,updated_at) VALUES(?,?,?,?,NOW(),?,?,?,?,false,?,NOW())').run(userId, profile.email, ownerName, 'ACTIVE', null, unusablePassword, salt, 'BUSINESS', profile.email_verified ? new Date().toISOString() : null)
  const role = await db.prepare("SELECT id FROM roles WHERE business_id=? AND code='BUSINESS_OWNER'").get(businessId)
  await db.prepare('INSERT INTO business_users(id,business_id,user_id,role_id,default_branch_id,status,created_at,joined_at,updated_at) VALUES(?,?,?,?,?,?,NOW(),NOW(),NOW())').run(randomUUID(), businessId, userId, role.id, tenant.branchId, 'ACTIVE')
  return db.prepare('SELECT * FROM users WHERE id=?').get(userId)
}

export async function handleGoogleAuth(req: any, res: any, url: any, db: any): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/auth/google/start') {
    const config = googleConfig()
    if (!config.clientId || !config.clientSecret || !config.redirectUri) { failure(res, 'Google sign-in is not configured yet'); return true }
    const state = randomBytes(24).toString('hex')
    const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: 'openid email profile', state, access_type: 'online', prompt: 'select_account' })
    redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params}`, { 'set-cookie': `zentro_google_state=${state}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=600${secure}` })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/google/callback') {
    try {
      const config = googleConfig(), expectedState = cookie(req, 'zentro_google_state'), state = url.searchParams.get('state'), code = url.searchParams.get('code')
      if (!config.clientId || !config.clientSecret || !config.redirectUri) throw new Error('Google sign-in is not configured yet')
      if (!code || !state || !expectedState || state !== expectedState) throw new Error('Google sign-in could not be verified, please try again')
      const tokens = await exchangeCode(code, config), profile = await fetchProfile(tokens.access_token)
      if (!profile.email) throw new Error('Google did not share an email address with Zentro')
      let user = await db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(profile.email)
      if (user && user.user_type !== 'BUSINESS') throw new Error('This Google account cannot access the business portal')
      if (!user) user = await createBusinessForGoogleUser(db, profile)
      const payload = await issueSession(req, db, user)
      redirect(res, '/app', { 'set-cookie': [...sessionCookies(payload.access, payload.refresh, payload.user.scope), `zentro_google_state=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secure}`] })
    } catch (error: any) {
      failure(res, error.message || 'Unable to sign in with Google')
    }
    return true
  }

  return false
}
