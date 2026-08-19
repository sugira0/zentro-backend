// @ts-nocheck
import { randomUUID } from 'node:crypto'

const send = (res: any, s: number, v: any) => { const b = JSON.stringify(v); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b) }
const read = async (req: any) => { let r = ''; for await (const c of req) r += c; return r ? JSON.parse(r) : {} }

export async function initializeTenantSubscriptions(db: any): Promise<void> {
  // Schema already created by schema.sql
}

async function detail(db: any, tenant: any): Promise<any> {
  const current = await db.prepare('SELECT s.*,p.code AS plan_code,p.name AS plan_name,p.monthly_price,p.branch_limit,p.user_limit FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.business_id=? ORDER BY s.starts_at DESC LIMIT 1').get(tenant.businessId)
  const plans = await db.prepare('SELECT * FROM subscription_plans WHERE is_active=true ORDER BY monthly_price').all()
  return { current, plans, guarantees: ['99.9% uptime', 'Secure cloud infrastructure', 'Automatic data backup', 'Regular updates', 'Mobile app access', 'Cancel anytime'] }
}

export async function handleTenantSubscriptions(req: any, res: any, url: any, db: any, tenant: any): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/subscription') return send(res, 200, await detail(db, tenant)), true

  if (req.method === 'POST' && url.pathname === '/api/subscription/upgrade') {
    const input = await read(req)
    const plan = await db.prepare('SELECT * FROM subscription_plans WHERE id=? AND is_active=true').get(input.planId)
    const current = await db.prepare('SELECT * FROM subscriptions WHERE business_id=? ORDER BY starts_at DESC LIMIT 1').get(tenant.businessId)
    const cycle = String(input.billingCycle || 'MONTHLY').toUpperCase()
    if (!current || !plan || !['MONTHLY', 'YEARLY'].includes(cycle)) return send(res, 400, { error: 'Choose a valid active subscription plan' }), true
    const next = new Date()
    cycle === 'YEARLY' ? next.setFullYear(next.getFullYear() + 1) : next.setMonth(next.getMonth() + 1)
    const amount = cycle === 'YEARLY' ? plan.monthly_price * 10 : plan.monthly_price
    await db.transaction(async (tx: any) => {
      await tx.prepare("UPDATE subscriptions SET plan_id=?,status='ACTIVE',billing_cycle=?,next_billing_at=?,ends_at=? WHERE id=?").run(plan.id, cycle, next.toISOString(), next.toISOString(), current.id)
      await tx.prepare("UPDATE businesses SET status='ACTIVE' WHERE id=?").run(tenant.businessId)
      await tx.prepare("INSERT INTO subscription_payments(id,subscription_id,amount,status,provider,created_at) VALUES(?,?,?,?,?,NOW())").run(randomUUID(), current.id, amount, 'SUCCESS', 'SELF_SERVICE')
      await tx.prepare('INSERT INTO subscription_change_requests(id,business_id,subscription_id,old_plan_id,new_plan_id,billing_cycle,status,requested_by,created_at) VALUES(?,?,?,?,?,?,?,?,NOW())').run(randomUUID(), tenant.businessId, current.id, current.plan_id, plan.id, cycle, 'COMPLETED', tenant.userId)
    })
    return send(res, 200, { ok: true, subscription: (await detail(db, tenant)).current }), true
  }

  return false
}

export async function enforceSubscriptionExpiry(db: any): Promise<void> {
  const expired = await db.prepare(`SELECT s.id,s.business_id FROM subscriptions s WHERE s.status IN ('ACTIVE','TRIAL') AND s.ends_at IS NOT NULL AND s.ends_at<NOW() AND s.id=(SELECT id FROM subscriptions WHERE business_id=s.business_id ORDER BY starts_at DESC LIMIT 1)`).all()
  if (!expired.length) return
  for (const row of expired) {
    await db.prepare("UPDATE subscriptions SET status='EXPIRED' WHERE id=?").run(row.id)
    await db.prepare("UPDATE businesses SET status='SUSPENDED' WHERE id=? AND status IN ('ACTIVE','TRIAL')").run(row.business_id)
  }
}

let expiryScheduler = false
export function startSubscriptionExpiryScheduler(db: any): void {
  if (expiryScheduler) return
  expiryScheduler = true
  enforceSubscriptionExpiry(db).catch(err => console.error('Subscription expiry sweep failed', err))
  setInterval(() => enforceSubscriptionExpiry(db).catch(err => console.error('Subscription expiry sweep failed', err)), 5 * 60000)
}
