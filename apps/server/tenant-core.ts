// @ts-nocheck
import { randomUUID } from 'node:crypto'

const now = () => new Date().toISOString()

const roleSeeds = [
  ['BUSINESS_OWNER','Business Owner'],['BUSINESS_ADMIN','Business Admin'],['MANAGER','Manager'],
  ['CASHIER','Cashier'],['SALESPERSON','Salesperson'],['SALES_EXECUTIVE','Sales Executive'],
  ['INVENTORY_OFFICER','Inventory Officer'],['STORE_KEEPER','Store Keeper'],['ACCOUNTANT','Accountant'],
  ['PROCUREMENT_OFFICER','Procurement Officer'],['WAREHOUSE_OFFICER','Warehouse Officer'],
  ['DELIVERY_DRIVER','Delivery Driver'],['WAITER','Waiter'],['WAITSTAFF','Waitstaff'],
  ['KITCHEN_STAFF','Kitchen Staff'],['MECHANIC','Mechanic'],['CARPENTER','Carpenter'],['VIEWER','Viewer']
]

const rolesByBusinessType: Record<string, string[]> = {
  restaurant:           ['BUSINESS_OWNER','BUSINESS_ADMIN','MANAGER','CASHIER','WAITER','WAITSTAFF','KITCHEN_STAFF','INVENTORY_OFFICER','ACCOUNTANT','VIEWER'],
  electronics:          ['BUSINESS_OWNER','BUSINESS_ADMIN','MANAGER','SALESPERSON','CASHIER','INVENTORY_OFFICER','PROCUREMENT_OFFICER','ACCOUNTANT','VIEWER'],
  hardware:             ['BUSINESS_OWNER','BUSINESS_ADMIN','MANAGER','SALESPERSON','CASHIER','INVENTORY_OFFICER','WAREHOUSE_OFFICER','PROCUREMENT_OFFICER','DELIVERY_DRIVER','ACCOUNTANT','VIEWER'],
  stationery:           ['BUSINESS_OWNER','BUSINESS_ADMIN','MANAGER','SALESPERSON','CASHIER','INVENTORY_OFFICER','ACCOUNTANT','VIEWER'],
  wholesale_importer:   ['BUSINESS_OWNER','BUSINESS_ADMIN','MANAGER','SALES_EXECUTIVE','WAREHOUSE_OFFICER','PROCUREMENT_OFFICER','DELIVERY_DRIVER','ACCOUNTANT','VIEWER'],
  supermarket:          ['BUSINESS_OWNER','BUSINESS_ADMIN','MANAGER','CASHIER','SALESPERSON','STORE_KEEPER','INVENTORY_OFFICER','PROCUREMENT_OFFICER','ACCOUNTANT','VIEWER'],
  fashion:              ['BUSINESS_OWNER','BUSINESS_ADMIN','MANAGER','SALESPERSON','CASHIER','INVENTORY_OFFICER','ACCOUNTANT','VIEWER'],
  auto_parts:           ['BUSINESS_OWNER','BUSINESS_ADMIN','MANAGER','SALESPERSON','CASHIER','INVENTORY_OFFICER','WAREHOUSE_OFFICER','PROCUREMENT_OFFICER','DELIVERY_DRIVER','ACCOUNTANT','VIEWER'],
  construction:         ['BUSINESS_OWNER','BUSINESS_ADMIN','MANAGER','SALES_EXECUTIVE','WAREHOUSE_OFFICER','PROCUREMENT_OFFICER','DELIVERY_DRIVER','ACCOUNTANT','VIEWER'],
  general_distribution: ['BUSINESS_OWNER','BUSINESS_ADMIN','MANAGER','SALES_EXECUTIVE','WAREHOUSE_OFFICER','PROCUREMENT_OFFICER','DELIVERY_DRIVER','ACCOUNTANT','VIEWER'],
  garage:               ['BUSINESS_OWNER','BUSINESS_ADMIN','MANAGER','MECHANIC','CASHIER','INVENTORY_OFFICER','ACCOUNTANT','VIEWER'],
  woodworking:          ['BUSINESS_OWNER','BUSINESS_ADMIN','MANAGER','CARPENTER','SALESPERSON','INVENTORY_OFFICER','PROCUREMENT_OFFICER','DELIVERY_DRIVER','ACCOUNTANT','VIEWER'],
}

const permissionModules = [
  ['dashboard','Dashboard'],['sales','Sales'],['customers','Customers'],['products','Products'],
  ['inventory','Inventory'],['procurement','Procurement'],['expenses','Expenses'],
  ['accounting','Accounting'],['cash_bank','Cash & Bank'],['loans','Loans'],
  ['staff','Staff'],['reports','Reports'],['settings','Settings'],
]
const permissionActions = ['view','create','edit','delete','approve','export']
const permissionSeeds = permissionModules.flatMap(([code]) =>
  permissionActions.map(action => [`${code}.${action}`, `${action[0].toUpperCase()+action.slice(1)} ${permissionModules.find(m=>m[0]===code)![1]}`])
)

const grant = (...pairs: [string, string[]][]) =>
  pairs.flatMap(([module, actions]) => actions.map(action => `${module}.${action}`))

const rolePermissions: Record<string, string | string[]> = {
  BUSINESS_OWNER: '*', BUSINESS_ADMIN: '*', MANAGER: '*',
  CASHIER:            grant(['sales',['view','create','edit']], ['products',['view']], ['customers',['view','create']]),
  SALESPERSON:        grant(['dashboard',['view']], ['products',['view']], ['sales',['view','create','edit']], ['customers',['view','create','edit']], ['reports',['view']]),
  SALES_EXECUTIVE:    grant(['dashboard',['view']], ['products',['view']], ['sales',['view','create','edit']], ['customers',['view','create','edit']], ['reports',['view']]),
  INVENTORY_OFFICER:  grant(['dashboard',['view']], ['products',['view','create','edit']], ['inventory',['view','create','edit']], ['procurement',['view','create']], ['reports',['view']]),
  STORE_KEEPER:       grant(['dashboard',['view']], ['products',['view','edit']], ['inventory',['view','create','edit']], ['reports',['view']]),
  ACCOUNTANT:         grant(['dashboard',['view']], ['sales',['view']], ['customers',['view']], ['expenses',['view','create','edit','approve']], ['accounting',['view','create','edit','approve']], ['cash_bank',['view','create','edit']], ['loans',['view','create','edit']], ['reports',['view','export']]),
  PROCUREMENT_OFFICER:grant(['dashboard',['view']], ['products',['view','create','edit']], ['procurement',['view','create','edit','approve']], ['reports',['view']]),
  WAREHOUSE_OFFICER:  grant(['dashboard',['view']], ['products',['view','edit']], ['inventory',['view','create','edit']], ['reports',['view']]),
  DELIVERY_DRIVER:    grant(['dashboard',['view']], ['sales',['view']]),
  WAITER:             grant(['sales',['view','create','edit']]),
  WAITSTAFF:          grant(['sales',['view','create','edit']]),
  KITCHEN_STAFF:      grant(['sales',['view']]),
  MECHANIC:           grant(['dashboard',['view']], ['sales',['view','create','edit']], ['products',['view']], ['inventory',['view']]),
  CARPENTER:          grant(['dashboard',['view']], ['products',['view','create','edit']], ['inventory',['view']], ['sales',['view']]),
  VIEWER:             grant(['dashboard',['view']], ['products',['view']], ['inventory',['view']], ['sales',['view']], ['procurement',['view']], ['reports',['view']]),
}

export async function initializeTenantCore(db: any): Promise<void> {
  // Schema already created by schema.sql — just seed access control
  await seedAccessControl(db)
}

export async function provisionBusinessTenant(db: any, businessId: string, businessTypeCode: string): Promise<{ branchId: string; warehouseId: string }> {
  const created = now()

  let branch = await db.prepare("SELECT * FROM branches WHERE business_id=? AND code='MAIN'").get(businessId)
  if (!branch) {
    const id = randomUUID()
    await db.prepare('INSERT INTO branches(id,business_id,name,code,address,status,created_at) VALUES(?,?,?,?,?,?,NOW())').run(id, businessId, 'Main Branch', 'MAIN', '', 'ACTIVE')
    branch = await db.prepare('SELECT * FROM branches WHERE id=?').get(id)
  }

  let warehouse = await db.prepare("SELECT * FROM warehouses WHERE business_id=? AND code='MAIN-WH'").get(businessId)
  if (!warehouse) {
    const id = randomUUID()
    await db.prepare('INSERT INTO warehouses(id,business_id,branch_id,name,code,status,created_at) VALUES(?,?,?,?,?,?,NOW())').run(id, businessId, branch.id, 'Main Warehouse', 'MAIN-WH', 'ACTIVE')
    warehouse = await db.prepare('SELECT * FROM warehouses WHERE id=?').get(id)
  }

  const allowedCodes = rolesByBusinessType[businessTypeCode] ?? roleSeeds.map(x => x[0])
  const relevantRoles = roleSeeds.filter(([code]) => allowedCodes.includes(code))

  for (const [code, name] of relevantRoles) {
    await db.prepare('INSERT INTO roles(id,business_id,code,name,is_system,created_at) VALUES(?,?,?,?,true,NOW()) ON CONFLICT(business_id,code) DO NOTHING').run(randomUUID(), businessId, code, name)
    const role = await db.prepare('SELECT id FROM roles WHERE business_id=? AND code=?').get(businessId, code)
    const codes = rolePermissions[code] === '*' ? permissionSeeds.map(x => x[0]) : (rolePermissions[code] as string[] || [])
    for (const permCode of codes) {
      const perm = await db.prepare('SELECT id FROM permissions WHERE code=?').get(permCode)
      if (perm && role) {
        await db.prepare('INSERT INTO role_permissions(role_id,permission_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(role.id, perm.id)
      }
    }
  }

  for (const [key, value] of Object.entries({ currency: 'RWF', timezone: 'Africa/Kigali', dateFormat: 'DD/MM/YYYY' })) {
    await db.prepare('INSERT INTO tenant_business_settings(business_id,key,value,updated_at) VALUES(?,?,?,NOW()) ON CONFLICT(business_id,key) DO NOTHING').run(businessId, key, value)
  }

  return { branchId: branch.id, warehouseId: warehouse.id }
}

async function seedAccessControl(db: any): Promise<void> {
  // Seed permissions
  for (const [code, name] of permissionSeeds) {
    await db.prepare('INSERT INTO permissions(id,code,name) VALUES(?,?,?) ON CONFLICT(code) DO NOTHING').run(randomUUID(), code, name)
  }

  // Seed roles for all existing businesses
  const businesses = await db.prepare('SELECT b.id, t.code AS type_code FROM businesses b LEFT JOIN business_types t ON t.id=b.business_type_id').all()
  for (const business of businesses) {
    const allowedCodes = rolesByBusinessType[business.type_code] ?? roleSeeds.map(x => x[0])
    for (const [code, name] of roleSeeds.filter(([c]) => allowedCodes.includes(c))) {
      await db.prepare('INSERT INTO roles(id,business_id,code,name,is_system,created_at) VALUES(?,?,?,?,true,NOW()) ON CONFLICT(business_id,code) DO NOTHING').run(randomUUID(), business.id, code, name)
    }
  }

  // Link role permissions
  const allRoles = await db.prepare('SELECT * FROM roles').all()
  for (const role of allRoles) {
    const codes = rolePermissions[role.code] === '*' ? permissionSeeds.map(x => x[0]) : (rolePermissions[role.code] as string[] || [])
    for (const code of codes) {
      const perm = await db.prepare('SELECT id FROM permissions WHERE code=?').get(code)
      if (perm) await db.prepare('INSERT INTO role_permissions(role_id,permission_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(role.id, perm.id)
    }
  }

  // Seed feature flags
  for (const [code, name] of [['multi_branch','Multi-branch operations'],['advanced_imports','Advanced imports and landed costs'],['custom_roles','Custom business roles']]) {
    await db.prepare('INSERT INTO feature_flags(id,code,name,enabled,created_at) VALUES(?,?,?,false,NOW()) ON CONFLICT(code) DO NOTHING').run(randomUUID(), code, name)
  }
}

export async function tenantContext(req: any, db: any, authUser: any): Promise<any> {
  if (!authUser || authUser.scope !== 'BUSINESS') return null
  const membership = await db.prepare(`
    SELECT bu.business_id, bu.default_branch_id AS branch_id, bu.role_id, r.code AS role_code
    FROM business_users bu JOIN roles r ON r.id=bu.role_id
    WHERE bu.user_id=? AND bu.business_id=? AND bu.status='ACTIVE'
  `).get(authUser.id, authUser.businessId)
  if (!membership) return null
  const permissions = (await db.prepare('SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=?').all(membership.role_id)).map((x: any) => x.code)
  const enabledModules = (await db.prepare('SELECT m.code FROM business_module_assignments a JOIN business_modules m ON m.id=a.module_id WHERE a.business_id=? AND a.enabled=true').all(membership.business_id)).map((x: any) => x.code)
  return { userId: authUser.id, businessId: membership.business_id, branchId: membership.branch_id, roleId: membership.role_id, role: membership.role_code, permissions, enabledModules }
}

export function hasRequiredModule(path: string, tenant: any): boolean {
  const rules: [RegExp, string][] = [
    [/^\/api\/(products|categories)/, 'catalog'],
    [/^\/api\/menu/, 'restaurant'],
    [/^\/api\/(inventory|stock-movements|transfers|warehouses)/, 'inventory'],
    [/^\/api\/(suppliers|purchase-orders)/, 'suppliers'],
    [/^\/api\/(expenses|accounting)/, 'expenses'],
    [/^\/api\/loans/, 'loans'],
  ]
  const match = rules.find(([pattern]) => pattern.test(path))
  if (match) return tenant.enabledModules.includes(match[1])
  if (/^\/api\/(orders|sales)/.test(path)) return ['retail_pos','restaurant','wholesale'].some(x => tenant.enabledModules.includes(x))
  return true
}

export async function recordTenantAudit(db: any, tenant: any, req: any, url: any): Promise<void> {
  if (!tenant || !['POST','PATCH','PUT','DELETE'].includes(req.method)) return
  await db.prepare('INSERT INTO audit_logs(id,business_id,branch_id,user_id,action,entity_type,entity_id,details,ip_address,created_at) VALUES(?,?,?,?,?,?,?,?,?,NOW())')
    .run(randomUUID(), tenant.businessId, tenant.branchId, tenant.userId, `${req.method}_REQUEST`, 'api', url.pathname, JSON.stringify({ method: req.method, path: url.pathname }), req.socket?.remoteAddress || null)
}
