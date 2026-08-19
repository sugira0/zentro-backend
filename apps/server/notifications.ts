// @ts-nocheck
import { randomUUID } from 'node:crypto'

const send = (res: any, s: number, v: any) => { const t = JSON.stringify(v); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(t) }); res.end(t) }
const read = async (req: any) => { let r = ''; for await (const c of req) r += c; return r ? JSON.parse(r) : {} }

export async function initializeNotifications(db: any): Promise<void> {
  // Tables already created by schema.sql
}

export async function notifyKitchen(db: any, tenant: any, order: any): Promise<void> {
  const itemCount = (order.items || []).reduce((s: number, x: any) => s + Number(x.quantity || 0), 0)
  const summary = (order.items || []).slice(0, 3).map((x: any) => `${x.quantity}× ${x.name}`).join(', ')
  const more = (order.items || []).length > 3 ? ` +${order.items.length - 3} more` : ''
  await db.prepare(`
    INSERT INTO tenant_notifications(id,business_id,branch_id,type,severity,title,message,source_key,action_view,created_at,expires_at,audience_role)
    VALUES(?,?,?,'KITCHEN','WARNING',?,?,?,?,NOW(),NULL,?)
    ON CONFLICT(business_id,source_key) DO UPDATE SET message=EXCLUDED.message,created_at=EXCLUDED.created_at,audience_role=EXCLUDED.audience_role
  `).run(randomUUID(), tenant.businessId, tenant.branchId, `New KOT · Order #${order.order_number}`, `${order.type} · ${itemCount} item${itemCount === 1 ? '' : 's'} · ${summary}${more}`, `kitchen-order:${order.id}`, 'sales-orders', 'KITCHEN_STAFF')
}

async function synchronize(db: any, tenant: any): Promise<void> {
  const lowItems = await db.prepare('SELECT id,name,quantity,reorder_level,unit FROM ingredients WHERE business_id=? AND quantity<=reorder_level').all(tenant.businessId)
  for (const item of lowItems) {
    const out = Number(item.quantity) <= 0
    await db.prepare(`
      INSERT INTO tenant_notifications(id,business_id,branch_id,type,severity,title,message,source_key,action_view,created_at,expires_at)
      VALUES(?,?,?,?,'INVENTORY',?,?,?,?,?,NOW(),NULL)
      ON CONFLICT(business_id,source_key) DO UPDATE SET severity=EXCLUDED.severity,title=EXCLUDED.title,message=EXCLUDED.message,
        created_at=CASE WHEN tenant_notifications.message<>EXCLUDED.message THEN EXCLUDED.created_at ELSE tenant_notifications.created_at END
    `).run(randomUUID(), tenant.businessId, tenant.branchId, 'INVENTORY', out ? 'CRITICAL' : 'WARNING', out ? `${item.name} is out of stock` : `${item.name} is running low`, out ? 'Sales and production may be blocked until this item is replenished.' : `${item.quantity} ${item.unit} remaining; reorder level is ${item.reorder_level}.`, `stock:${item.id}`, 'alerts')
  }

  const pending = (await db.prepare("SELECT COUNT(*) AS count FROM purchase_orders WHERE business_id=? AND branch_id=? AND status IN ('DRAFT','PENDING')").get(tenant.businessId, tenant.branchId))?.count || 0
  if (pending) await db.prepare(`INSERT INTO tenant_notifications(id,business_id,branch_id,type,severity,title,message,source_key,action_view,created_at,expires_at) VALUES(?,?,?,'PROCUREMENT','INFO','Purchase orders need attention',?,'purchase-orders:pending','purchase-orders',NOW(),NULL) ON CONFLICT(business_id,source_key) DO UPDATE SET message=EXCLUDED.message,created_at=EXCLUDED.created_at`).run(randomUUID(), tenant.businessId, tenant.branchId, `${pending} purchase order${pending === 1 ? ' is' : 's are'} waiting for review.`)

  const overdue = (await db.prepare("SELECT COUNT(*) AS count FROM loans WHERE business_id=? AND branch_id=? AND due_date<CURRENT_DATE AND amount_paid<principal").get(tenant.businessId, tenant.branchId))?.count || 0
  if (overdue) await db.prepare(`INSERT INTO tenant_notifications(id,business_id,branch_id,type,severity,title,message,source_key,action_view,created_at,expires_at) VALUES(?,?,?,'CREDIT','CRITICAL','Overdue customer credit',?,'loans:overdue','alerts',NOW(),NULL) ON CONFLICT(business_id,source_key) DO UPDATE SET message=EXCLUDED.message,created_at=EXCLUDED.created_at`).run(randomUUID(), tenant.businessId, tenant.branchId, `${overdue} account${overdue === 1 ? ' is' : 's are'} past the repayment due date.`)
}

export async function handleNotifications(req: any, res: any, url: any, db: any, tenant: any): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/notifications') {
    await synchronize(db, tenant)
    const items = await db.prepare(`
      SELECT n.*, CASE WHEN r.read_at IS NULL THEN false ELSE true END AS is_read
      FROM tenant_notifications n
      LEFT JOIN notification_reads r ON r.notification_id=n.id AND r.user_id=?
      WHERE n.business_id=? AND (n.branch_id IS NULL OR n.branch_id=?)
        AND (n.audience_role IS NULL OR n.audience_role=?)
        AND (n.expires_at IS NULL OR n.expires_at>NOW())
      ORDER BY is_read,n.created_at DESC LIMIT 50`).all(tenant.userId, tenant.businessId, tenant.branchId, tenant.role)
    return send(res, 200, { items, unread: items.filter((x: any) => !x.is_read).length }), true
  }

  const item = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/)
  if (req.method === 'POST' && item) {
    const exists = await db.prepare('SELECT 1 FROM tenant_notifications WHERE id=? AND business_id=? AND (audience_role IS NULL OR audience_role=?)').get(item[1], tenant.businessId, tenant.role)
    if (!exists) return send(res, 404, { error: 'Notification not found' }), true
    await db.prepare('INSERT INTO notification_reads(notification_id,user_id,read_at) VALUES(?,?,NOW()) ON CONFLICT(notification_id,user_id) DO UPDATE SET read_at=NOW()').run(item[1], tenant.userId)
    return send(res, 200, { ok: true }), true
  }

  if (req.method === 'POST' && url.pathname === '/api/notifications/read-all') {
    await db.prepare(`
      INSERT INTO notification_reads(notification_id,user_id,read_at)
      SELECT id,?,NOW() FROM tenant_notifications
      WHERE business_id=? AND (branch_id IS NULL OR branch_id=?) AND (audience_role IS NULL OR audience_role=?)
      ON CONFLICT(notification_id,user_id) DO UPDATE SET read_at=NOW()
    `).run(tenant.userId, tenant.businessId, tenant.branchId, tenant.role)
    return send(res, 200, { ok: true }), true
  }

  if (req.method === 'POST' && url.pathname === '/api/notifications/test') {
    const x = await read(req), id = randomUUID()
    await db.prepare('INSERT INTO tenant_notifications(id,business_id,branch_id,type,severity,title,message,source_key,action_view,created_at,expires_at,audience_role) VALUES(?,?,?,?,?,?,?,?,?,NOW(),NULL,NULL)').run(id, tenant.businessId, tenant.branchId, 'SYSTEM', x.severity || 'INFO', x.title || 'Test notification', x.message || 'Zentro notifications are working correctly.', `test:${id}`, x.actionView || 'alerts')
    return send(res, 201, { id }), true
  }

  return false
}
