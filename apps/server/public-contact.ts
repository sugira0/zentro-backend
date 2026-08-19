// @ts-nocheck
import { randomUUID } from 'node:crypto'
import { sendEmail } from './email.ts'

const reply = (res: any, s: number, v: any) => { const d = JSON.stringify(v); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) }); res.end(d) }
const read = async (req: any) => { let r = ''; for await (const c of req) { r += c; if (r.length > 50000) throw new Error('Request is too large') }; return r ? JSON.parse(r) : {} }
const clean = (v: any, max = 500) => String(v || '').trim().slice(0, max)
const escape = (v: any) => String(v).replace(/[&<>"']/g, (c: string) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

export async function initializePublicContact(db: any): Promise<void> {
  // Schema already created by schema.sql
}

export async function handlePublicContact(req: any, res: any, url: any, db: any): Promise<boolean> {
  if (req.method !== 'POST' || url.pathname !== '/api/public/contact') return false

  const input = await read(req), name = clean(input.name, 120), email = clean(input.email, 180).toLowerCase()
  const phone = clean(input.phone, 60), business = clean(input.business, 160), topic = clean(input.topic, 80)
  const message = clean(input.message, 4000), website = clean(input.website, 100)

  if (website) return reply(res, 200, { ok: true }), true
  if (!name || !email || !topic || !message) return reply(res, 400, { error: 'Name, email, topic and message are required' }), true
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(res, 400, { error: 'Enter a valid email address' }), true

  const recent = await db.prepare("SELECT COUNT(*) AS count FROM public_contact_enquiries WHERE email=? AND created_at>NOW()-INTERVAL '15 minutes'").get(email)
  if ((recent?.count || 0) >= 3) return reply(res, 429, { error: 'Too many messages. Please wait before trying again.' }), true

  const id = randomUUID()
  await db.prepare('INSERT INTO public_contact_enquiries(id,name,email,phone,business_name,topic,message,status,created_at) VALUES(?,?,?,?,?,?,?,?,NOW())').run(id, name, email, phone || null, business || null, topic, message, 'NEW')

  await sendEmail({
    to: process.env.CONTACT_EMAIL || 'info@zentrobm.rw',
    subject: `Zentro website enquiry: ${topic}`,
    text: `Name: ${name}\nEmail: ${email}\nPhone: ${phone || 'Not provided'}\nBusiness: ${business || 'Not provided'}\nTopic: ${topic}\n\n${message}`,
    html: `<h2>New Zentro website enquiry</h2><p><b>Name:</b> ${escape(name)}<br><b>Email:</b> ${escape(email)}<br><b>Phone:</b> ${escape(phone || 'Not provided')}<br><b>Business:</b> ${escape(business || 'Not provided')}<br><b>Topic:</b> ${escape(topic)}</p><p>${escape(message).replace(/\n/g, '<br>')}</p>`,
  })

  return reply(res, 201, { ok: true, id }), true
}
