// @ts-nocheck
import { randomUUID } from 'node:crypto'
import { createBusinessOwnerAccount } from './auth.ts'

const send = (res: any, s: number, v: any) => { const t = JSON.stringify(v); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(t) }); res.end(t) }
const read = async (req: any) => { let t = ''; for await (const c of req) t += c; return t ? JSON.parse(t) : {} }

export async function initializeStaff(db: any): Promise<void> {
  // Schema already created by schema.sql
}

export async function handleStaff(req: any, res: any, url: any, db: any, t: any): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/staff') {
    const roles = await db.prepare('SELECT id,code,name FROM roles WHERE business_id=? ORDER BY name').all(t.businessId)
    const branches = await db.prepare("SELECT id,name FROM branches WHERE business_id=? AND status='ACTIVE' ORDER BY name").all(t.businessId)
    const items = await db.prepare(`
      SELECT sp.*,u.name,u.email,u.phone,u.status,bu.role_id,r.code AS role_code,r.name AS role_name,b.name AS branch_name
      FROM staff_profiles sp
      JOIN users u ON u.id=sp.user_id
      JOIN business_users bu ON bu.user_id=u.id AND bu.business_id=sp.business_id
      JOIN roles r ON r.id=bu.role_id
      LEFT JOIN branches b ON b.id=sp.branch_id
      WHERE sp.business_id=? ORDER BY sp.join_date DESC`).all(t.businessId)
    const departments = [...new Set(items.map((x: any) => x.department))]
    const month = new Date().toISOString().slice(0, 7)
    return send(res, 200, { items, roles, branches, departments, byDepartment: departments.map(name => ({ name, count: items.filter((x: any) => x.department === name).length })), recentHires: items.slice(0, 5), birthdays: items.filter((x: any) => x.birth_date).sort((a: any, b: any) => String(a.birth_date).slice(5).localeCompare(String(b.birth_date).slice(5))).slice(0, 5), summary: { total: items.length, active: items.filter((x: any) => x.status === 'ACTIVE').length, inactive: items.filter((x: any) => x.status !== 'ACTIVE').length, departments: departments.length, newThisMonth: items.filter((x: any) => String(x.join_date).slice(0, 7) === month).length, male: items.filter((x: any) => x.gender === 'MALE').length, female: items.filter((x: any) => x.gender === 'FEMALE').length } }), true
  }

  if (req.method === 'POST' && url.pathname === '/api/staff') {
    const x = await read(req)
    const role = await db.prepare('SELECT * FROM roles WHERE id=? AND business_id=?').get(x.roleId, t.businessId)
    const branch = await db.prepare('SELECT * FROM branches WHERE id=? AND business_id=?').get(x.branchId || t.branchId, t.businessId)
    if (!x.name || !x.email || !role || !branch || !x.department) return send(res, 400, { error: 'Name, email, department, branch and role are required' }), true
    const countRow = await db.prepare('SELECT COUNT(*) AS n FROM staff_profiles WHERE business_id=?').get(t.businessId)
    const code = `EMP-${String(countRow.n + 1).padStart(3, '0')}`
    try {
      const account = await createBusinessOwnerAccount(db, { businessId: t.businessId, name: String(x.name).trim(), email: String(x.email).trim(), phone: String(x.phone || '').trim() || null, password: x.temporaryPassword, branchId: branch.id })
      await db.prepare('UPDATE business_users SET role_id=?,default_branch_id=?,updated_at=NOW() WHERE business_id=? AND user_id=?').run(role.id, branch.id, t.businessId, account.id)
      await db.prepare('INSERT INTO staff_profiles(id,business_id,branch_id,user_id,employee_code,department,job_title,gender,birth_date,join_date,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,NOW())').run(randomUUID(), t.businessId, branch.id, account.id, code, String(x.department).trim(), String(x.jobTitle || role.name).trim(), x.gender || null, x.birthDate || null, x.joinDate || new Date().toISOString().slice(0, 10))
      return send(res, 201, { userId: account.id, employeeCode: code, temporaryPassword: account.temporaryPassword }), true
    } catch (error: any) {
      return send(res, 409, { error: error.message || 'Could not create staff account' }), true
    }
  }

  const member = url.pathname.match(/^\/api\/staff\/([^/]+)$/)
  if (member && req.method === 'PATCH') {
    const x = await read(req), row = await db.prepare('SELECT * FROM staff_profiles WHERE user_id=? AND business_id=?').get(member[1], t.businessId)
    if (!row) return send(res, 404, { error: 'Staff member not found' }), true
    const status = x.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE'
    await db.transaction(async (tx: any) => {
      await tx.prepare('UPDATE users SET status=?,updated_at=NOW() WHERE id=?').run(status, row.user_id)
      await tx.prepare('UPDATE business_users SET status=?,updated_at=NOW() WHERE business_id=? AND user_id=?').run(status, t.businessId, row.user_id)
    })
    return send(res, 200, { ok: true }), true
  }

  return false
}
