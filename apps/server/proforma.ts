// @ts-nocheck
import { randomUUID } from 'node:crypto'

const send = (res: any, s: number, v: any) => { const b = JSON.stringify(v); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b) }
const json = async (req: any) => { let r = ''; for await (const c of req) r += c; return r ? JSON.parse(r) : {} }
const templates = ['classic', 'modern', 'detailed', 'minimal', 'luxury', 'bold']
const view = (row: any) => { const lapsed = !['ACCEPTED', 'CONVERTED', 'CANCELLED'].includes(row.status) && new Date(row.valid_until) < new Date(new Date().toDateString()); return { ...row, status: lapsed ? 'EXPIRED' : row.status } }

export async function initializeProforma(db: any): Promise<void> {
  // Schema already created by schema.sql
}

async function detail(db: any, id: string, t: any): Promise<any> {
  const row = await db.prepare('SELECT * FROM proformas WHERE id=? AND business_id=? AND branch_id=?').get(id, t.businessId, t.branchId)
  if (!row) return null
  return { ...view(row), items: await db.prepare('SELECT * FROM proforma_items WHERE proforma_id=? AND business_id=?').all(id, t.businessId) }
}

export async function handleProforma(req: any, res: any, url: any, db: any, t: any): Promise<boolean> {
  const path = url.pathname
  if (!path.startsWith('/api/proforma')) return false

  if (req.method === 'GET' && path === '/api/proforma') {
    const items = (await db.prepare('SELECT * FROM proformas WHERE business_id=? AND branch_id=? ORDER BY issued_at DESC').all(t.businessId, t.branchId)).map(view)
    const summary = { all: items.length, draft: items.filter((x: any) => x.status === 'DRAFT').length, sent: items.filter((x: any) => x.status === 'SENT').length, accepted: items.filter((x: any) => x.status === 'ACCEPTED').length, expired: items.filter((x: any) => x.status === 'EXPIRED').length, converted: items.filter((x: any) => x.status === 'CONVERTED').length, totalValue: items.reduce((n: number, x: any) => n + x.total, 0) }
    return send(res, 200, { items, summary }), true
  }

  if (req.method === 'POST' && path === '/api/proforma') {
    const x = await json(req), customer = String(x.customerName || '').trim(), lines = Array.isArray(x.items) ? x.items : []
    if (!customer || !lines.length) return send(res, 400, { error: 'Customer and at least one item are required' }), true
    const ids = [...new Set(lines.map((l: any) => Number(l.menuItemId)).filter(Boolean))]
    const menu = ids.length ? await db.prepare(`SELECT * FROM menu_items WHERE business_id=? AND id IN (${ids.map(() => '?').join(',')})`).all(t.businessId, ...ids) : []
    const normalized = lines.map((l: any) => { const product = menu.find((m: any) => m.id === Number(l.menuItemId)), givenPrice = Number(l.unitPrice); return { menuItemId: product ? product.id : null, name: String(l.name || product?.name || '').trim(), quantity: Math.max(1, Number(l.quantity) || 1), unitPrice: Math.max(0, Math.trunc(Number.isFinite(givenPrice) ? givenPrice : Number(product?.price) || 0)) } }).filter((l: any) => l.name)
    if (!normalized.length) return send(res, 400, { error: 'At least one valid item is required' }), true
    const subtotal = normalized.reduce((n: number, l: any) => n + l.quantity * l.unitPrice, 0), discount = Math.min(Math.max(0, Math.trunc(Number(x.discount) || 0)), subtotal), tax = Math.max(0, Math.trunc(Number(x.tax) || 0)), total = subtotal - discount + tax
    const validUntil = new Date(String(x.validUntil || Date.now() + 14 * 86400000))
    if (Number.isNaN(validUntil.getTime())) return send(res, 400, { error: 'A valid "valid until" date is required' }), true
    const template = templates.includes(x.template) ? x.template : 'classic', id = randomUUID()
    const countRow = await db.prepare('SELECT COUNT(*) AS n FROM proformas WHERE business_id=?').get(t.businessId)
    const number = `PF-${new Date().getFullYear()}-${String(countRow.n + 1).padStart(5, '0')}`
    await db.transaction(async (tx: any) => {
      await tx.prepare('INSERT INTO proformas(id,proforma_number,business_id,branch_id,customer_name,customer_email,customer_phone,customer_address,status,template,issued_at,valid_until,subtotal,discount,tax,total,terms,notes,converted_order_id,created_by,created_at,bank_name,bank_account_name,bank_account_number,momo_name,momo_number,company_stamp,company_signature,signatory_name,signatory_title) VALUES(?,?,?,?,?,?,?,?,?,?,NOW(),?,?,?,?,?,?,?,NULL,?,NOW(),?,?,?,?,?,?,?,?,?)').run(id, number, t.businessId, t.branchId, customer, String(x.customerEmail || '').trim() || null, String(x.customerPhone || '').trim() || null, String(x.customerAddress || '').trim() || null, 'DRAFT', template, validUntil.toISOString(), subtotal, discount, tax, total, String(x.terms || '').trim() || null, String(x.notes || '').trim() || null, t.userId || null, String(x.bankName || '').trim() || null, String(x.bankAccountName || '').trim() || null, String(x.bankAccountNumber || '').trim() || null, String(x.momoName || '').trim() || null, String(x.momoNumber || '').trim() || null, String(x.companyStamp || '') || null, String(x.companySignature || '') || null, String(x.signatoryName || '').trim() || null, String(x.signatoryTitle || '').trim() || null)
      for (const l of normalized) await tx.prepare('INSERT INTO proforma_items(id,proforma_id,business_id,menu_item_id,name,quantity,unit_price) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, t.businessId, l.menuItemId, l.name, l.quantity, l.unitPrice)
    })
    return send(res, 201, { id, proformaNumber: number, total }), true
  }

  const match = path.match(/^\/api\/proforma\/([^/]+)$/)
  if (req.method === 'GET' && match) { const row = await detail(db, match[1], t); return row ? send(res, 200, row) : send(res, 404, { error: 'Proforma not found' }), true }

  if (req.method === 'PATCH' && match) {
    const current = await db.prepare('SELECT * FROM proformas WHERE id=? AND business_id=? AND branch_id=?').get(match[1], t.businessId, t.branchId)
    if (!current) return send(res, 404, { error: 'Proforma not found' }), true
    if (current.status === 'CONVERTED') return send(res, 409, { error: 'A converted proforma cannot be changed' }), true
    const x = await json(req), allowedStatus = ['DRAFT', 'SENT', 'ACCEPTED', 'EXPIRED', 'CANCELLED']
    const status = x.status && allowedStatus.includes(x.status) ? x.status : current.status
    const template = templates.includes(x.template) ? x.template : current.template
    const validUntil = x.validUntil ? new Date(x.validUntil) : null
    if (x.validUntil && Number.isNaN(validUntil?.getTime())) return send(res, 400, { error: 'Invalid "valid until" date' }), true
    await db.prepare('UPDATE proformas SET status=?,template=?,terms=?,notes=?,valid_until=? WHERE id=? AND business_id=?').run(status, template, x.terms ?? current.terms, x.notes ?? current.notes, validUntil ? validUntil.toISOString() : current.valid_until, current.id, t.businessId)
    return send(res, 200, await detail(db, current.id, t)), true
  }

  if (req.method === 'DELETE' && match) {
    const current = await db.prepare('SELECT * FROM proformas WHERE id=? AND business_id=? AND branch_id=?').get(match[1], t.businessId, t.branchId)
    if (!current) return send(res, 404, { error: 'Proforma not found' }), true
    if (current.status === 'CONVERTED') return send(res, 409, { error: 'A converted proforma cannot be deleted' }), true
    await db.transaction(async (tx: any) => {
      await tx.prepare('DELETE FROM proforma_items WHERE proforma_id=? AND business_id=?').run(current.id, t.businessId)
      await tx.prepare('DELETE FROM proformas WHERE id=? AND business_id=?').run(current.id, t.businessId)
    })
    return send(res, 200, { ok: true }), true
  }

  const convert = path.match(/^\/api\/proforma\/([^/]+)\/convert$/)
  if (req.method === 'POST' && convert) {
    const current = await db.prepare('SELECT * FROM proformas WHERE id=? AND business_id=? AND branch_id=?').get(convert[1], t.businessId, t.branchId)
    if (!current) return send(res, 404, { error: 'Proforma not found' }), true
    if (current.status === 'CONVERTED') return send(res, 409, { error: 'This proforma has already been converted' }), true
    const items = await db.prepare('SELECT * FROM proforma_items WHERE proforma_id=? AND business_id=?').all(current.id, t.businessId)
    if (!items.length || items.some((l: any) => !l.menu_item_id)) return send(res, 409, { error: 'Every line item must reference a catalog product before converting to an order' }), true
    const orderId = randomUUID()
    const numRow = await db.prepare('SELECT COALESCE(MAX(order_number),1047)+1 AS n FROM orders').get()
    const number = Number(numRow.n)
    await db.transaction(async (tx: any) => {
      await tx.prepare('INSERT INTO orders(id,order_number,type,table_name,guests,status,subtotal,discount,tax,total,created_at,paid_at,inventory_deducted,business_id,branch_id) VALUES(?,?,?,?,?,?,?,?,?,?,NOW(),NULL,false,?,?)').run(orderId, number, 'Proforma', current.customer_name, 1, 'OPEN', current.subtotal, current.discount, current.tax, current.total, t.businessId, t.branchId)
      for (const l of items) await tx.prepare('INSERT INTO order_items(order_id,menu_item_id,name,unit_price,quantity,business_id) VALUES(?,?,?,?,?,?)').run(orderId, l.menu_item_id, l.name, l.unit_price, l.quantity, t.businessId)
      await tx.prepare("UPDATE proformas SET status='CONVERTED',converted_order_id=? WHERE id=? AND business_id=?").run(orderId, current.id, t.businessId)
    })
    return send(res, 201, { orderId, orderNumber: number }), true
  }

  return false
}
