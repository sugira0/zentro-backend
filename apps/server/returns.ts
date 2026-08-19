// @ts-nocheck
import { randomUUID } from 'node:crypto'

const send = (res: any, s: number, v: any) => { const b = JSON.stringify(v); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b) }
const read = async (req: any) => { let b = ''; for await (const c of req) b += c; return b ? JSON.parse(b) : {} }

export async function initializeReturns(db: any): Promise<void> {
  // Tables already created by schema.sql
  // Migrate old COMPLETED→REFUNDED
  await db.prepare("UPDATE sales_returns SET status='REFUNDED',refunded_at=COALESCE(refunded_at,created_at),updated_at=COALESCE(updated_at,created_at) WHERE status='COMPLETED'").run()
}

async function overview(db: any, businessId: string, branchId: string): Promise<any> {
  const items = await db.prepare(`SELECT r.*,o.order_number,o.type,o.table_name AS customer FROM sales_returns r JOIN orders o ON o.id=r.order_id AND o.business_id=r.business_id WHERE r.business_id=? AND r.branch_id=? ORDER BY r.created_at DESC`).all(businessId, branchId)
  const value = (status: string) => items.filter((x: any) => x.status === status).reduce((n: number, x: any) => n + x.refund_amount, 0)
  const reasons = await db.prepare(`SELECT reason AS name,COUNT(*) AS count,SUM(refund_amount) AS value FROM sales_returns WHERE business_id=? AND branch_id=? GROUP BY reason ORDER BY count DESC,value DESC LIMIT 5`).all(businessId, branchId)
  const trend = await db.prepare(`SELECT TO_CHAR(created_at,'YYYY-MM-DD') AS day,SUM(refund_amount) AS value FROM sales_returns WHERE business_id=? AND branch_id=? AND created_at>=NOW()-INTERVAL '30 days' GROUP BY day ORDER BY day`).all(businessId, branchId)
  const eligible = await db.prepare(`SELECT o.*,COUNT(oi.id) AS item_count FROM orders o JOIN order_items oi ON oi.order_id=o.id AND oi.business_id=o.business_id WHERE o.business_id=? AND o.branch_id=? AND o.status='PAID' GROUP BY o.id ORDER BY o.paid_at DESC LIMIT 100`).all(businessId, branchId)
  return { returns: items, eligible, summary: { all: items.length, totalValue: items.reduce((n: number, x: any) => n + x.refund_amount, 0), pending: items.filter((x: any) => x.status === 'PENDING').length, pendingValue: value('PENDING'), approved: items.filter((x: any) => x.status === 'APPROVED').length, approvedValue: value('APPROVED'), refunded: items.filter((x: any) => x.status === 'REFUNDED').length, refundedValue: value('REFUNDED'), rejected: items.filter((x: any) => x.status === 'REJECTED').length, rejectedValue: value('REJECTED') }, reasons, trend, activities: items.slice(0, 6).map((x: any) => ({ id: x.id, title: `${x.return_number} ${x.status.toLowerCase()}`, status: x.status, createdAt: x.updated_at || x.created_at })) }
}

async function restoreStock(db: any, record: any, tenant: any): Promise<void> {
  if (!record.requested_restock || record.restocked) return
  const order = await db.prepare('SELECT * FROM orders WHERE id=? AND business_id=?').get(record.order_id, tenant.businessId)
  if (!order?.inventory_deducted) return
  const lines = await db.prepare('SELECT * FROM sales_return_items WHERE return_id=? AND business_id=?').all(record.id, tenant.businessId)
  for (const line of lines) {
    const components = await db.prepare(`SELECT r.ingredient_id,r.quantity,i.warehouse_id FROM recipe_components r JOIN ingredients i ON i.id=r.ingredient_id AND i.business_id=r.business_id WHERE r.menu_item_id=? AND r.business_id=?`).all(line.menu_item_id, tenant.businessId)
    for (const c of components) {
      const qty = c.quantity * line.quantity
      await db.prepare('UPDATE ingredients SET quantity=quantity+?,updated_at=NOW() WHERE id=? AND business_id=?').run(qty, c.ingredient_id, tenant.businessId)
      await db.prepare('INSERT INTO stock_movements(id,ingredient_id,type,quantity,reason,created_at,business_id,branch_id,warehouse_id) VALUES(?,?,?,?,?,NOW(),?,?,?)').run(randomUUID(), c.ingredient_id, 'RETURN', qty, record.return_number, tenant.businessId, tenant.branchId, c.warehouse_id)
    }
  }
  await db.prepare('UPDATE sales_returns SET restocked=true WHERE id=? AND business_id=?').run(record.id, tenant.businessId)
}

export async function handleReturns(req: any, res: any, url: any, db: any, tenant: any): Promise<boolean> {
  const { businessId, branchId } = tenant, path = url.pathname

  if (req.method === 'GET' && path === '/api/returns') return send(res, 200, await overview(db, businessId, branchId)), true

  const orderDetail = path.match(/^\/api\/returns\/orders\/([^/]+)$/)
  if (req.method === 'GET' && orderDetail) {
    const order = await db.prepare("SELECT * FROM orders WHERE id=? AND business_id=? AND branch_id=? AND status='PAID'").get(orderDetail[1], businessId, branchId)
    if (!order) return send(res, 404, { error: 'Paid order not found' }), true
    const items = await db.prepare(`SELECT oi.menu_item_id AS "menuItemId",oi.name,oi.unit_price AS "unitPrice",oi.quantity-COALESCE((SELECT SUM(ri.quantity) FROM sales_return_items ri JOIN sales_returns r ON r.id=ri.return_id WHERE r.order_id=oi.order_id AND ri.menu_item_id=oi.menu_item_id AND r.status<>'REJECTED'),0) AS "returnableQuantity" FROM order_items oi WHERE oi.order_id=? AND oi.business_id=?`).all(order.id, businessId)
    return send(res, 200, { ...order, items }), true
  }

  const detail = path.match(/^\/api\/returns\/([^/]+)$/)
  if (req.method === 'GET' && detail) {
    const record = await db.prepare(`SELECT r.*,o.order_number,o.type,o.table_name AS customer FROM sales_returns r JOIN orders o ON o.id=r.order_id WHERE r.id=? AND r.business_id=? AND r.branch_id=?`).get(detail[1], businessId, branchId)
    if (!record) return send(res, 404, { error: 'Return not found' }), true
    return send(res, 200, { ...record, items: await db.prepare('SELECT * FROM sales_return_items WHERE return_id=? AND business_id=?').all(record.id, businessId) }), true
  }

  if (req.method === 'POST' && path === '/api/returns') {
    const x = await read(req)
    const order = await db.prepare("SELECT * FROM orders WHERE id=? AND business_id=? AND branch_id=? AND status='PAID'").get(x.orderId, businessId, branchId)
    if (!order) return send(res, 404, { error: 'Paid order not found' }), true
    if (!x.reason || !Array.isArray(x.items) || !x.items.length) return send(res, 400, { error: 'Reason and at least one returned item are required' }), true
    const sold = await db.prepare('SELECT * FROM order_items WHERE order_id=? AND business_id=?').all(order.id, businessId)
    const lines: any[] = []
    for (const input of x.items) {
      const item = sold.find((i: any) => i.menu_item_id === Number(input.menuItemId))
      const quantity = Math.trunc(Number(input.quantity))
      const alreadyRow = await db.prepare(`SELECT COALESCE(SUM(ri.quantity),0) AS qty FROM sales_return_items ri JOIN sales_returns r ON r.id=ri.return_id WHERE r.order_id=? AND ri.menu_item_id=? AND r.status<>'REJECTED'`).get(order.id, Number(input.menuItemId))
      const already = alreadyRow?.qty || 0
      if (!item || quantity < 1 || quantity > item.quantity - already) return send(res, 409, { error: `Invalid return quantity for ${item?.name || 'item'}` }), true
      lines.push({ ...item, quantity })
    }
    const amount = Math.round(lines.reduce((n: number, i: any) => n + i.unit_price * i.quantity, 0) * 1.18)
    const id = randomUUID(), number = `RTN-${Date.now().toString().slice(-7)}`
    await db.transaction(async (tx: any) => {
      await tx.prepare('INSERT INTO sales_returns(id,return_number,order_id,reason,refund_method,refund_amount,status,restocked,created_at,business_id,branch_id,requested_restock,updated_at) VALUES(?,?,?,?,?,?,?,false,NOW(),?,?,?,NOW())').run(id, number, order.id, x.reason, x.refundMethod || 'Cash', amount, 'PENDING', businessId, branchId, x.restock === false ? false : true)
      for (const line of lines) await tx.prepare('INSERT INTO sales_return_items VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, line.menu_item_id, line.name, line.unit_price, line.quantity, businessId)
    })
    return send(res, 201, { id, returnNumber: number, refundAmount: amount, status: 'PENDING' }), true
  }

  const review = path.match(/^\/api\/returns\/([^/]+)\/review$/)
  if (req.method === 'POST' && review) {
    const x = await read(req), status = String(x.status || '').toUpperCase()
    if (!['APPROVED', 'REJECTED'].includes(status)) return send(res, 400, { error: 'Choose APPROVED or REJECTED' }), true
    const record = await db.prepare('SELECT * FROM sales_returns WHERE id=? AND business_id=? AND branch_id=?').get(review[1], businessId, branchId)
    if (!record) return send(res, 404, { error: 'Return not found' }), true
    if (record.status !== 'PENDING') return send(res, 409, { error: 'Only pending returns can be reviewed' }), true
    await db.prepare('UPDATE sales_returns SET status=?,review_note=?,reviewed_at=NOW(),updated_at=NOW() WHERE id=? AND business_id=?').run(status, String(x.note || ''), record.id, businessId)
    return send(res, 200, { ok: true, status }), true
  }

  const refund = path.match(/^\/api\/returns\/([^/]+)\/refund$/)
  if (req.method === 'POST' && refund) {
    const record = await db.prepare('SELECT * FROM sales_returns WHERE id=? AND business_id=? AND branch_id=?').get(refund[1], businessId, branchId)
    if (!record) return send(res, 404, { error: 'Return not found' }), true
    if (record.status !== 'APPROVED') return send(res, 409, { error: 'Approve this return before issuing its refund' }), true
    const x = await read(req)
    await db.transaction(async (tx: any) => {
      await tx.prepare('UPDATE sales_returns SET status=?,refund_method=?,refunded_at=NOW(),updated_at=NOW() WHERE id=? AND business_id=?').run('REFUNDED', String(x.method || record.refund_method), record.id, businessId)
    })
    await restoreStock(db, record, tenant)
    return send(res, 200, { ok: true, status: 'REFUNDED', amount: record.refund_amount }), true
  }

  return false
}
