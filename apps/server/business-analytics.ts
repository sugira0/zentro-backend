// @ts-nocheck
const num = (v: any) => Number(v || 0)
const pct = (curr: number, prev: number) => prev ? Number(((curr - prev) / Math.abs(prev) * 100).toFixed(1)) : (curr ? 100 : 0)
const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)))
const grade = (s: number) => s >= 85 ? 'Excellent' : s >= 65 ? 'Good' : s >= 45 ? 'Average' : 'Needs attention'

async function salesPeriod(db: any, tenant: any, start: string, end: string): Promise<any> {
  return db.prepare(`SELECT COALESCE(SUM(p.amount),0) AS revenue,COUNT(DISTINCT p.order_id) AS orders FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.business_id=? AND p.branch_id=? AND p.status='COMPLETED' AND p.created_at>=$1::timestamptz AND p.created_at<$2::timestamptz`).get(tenant.businessId, tenant.branchId, start, end)
}

export async function businessAnalytics(db: any, tenant: any): Promise<any> {
  const now = new Date(), day = 24 * 60 * 60 * 1000
  const today = new Date(now); today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today.getTime() + day), yesterday = new Date(today.getTime() - day)

  const todaySales = await salesPeriod(db, tenant, today.toISOString(), tomorrow.toISOString())
  const yesterdaySales = await salesPeriod(db, tenant, yesterday.toISOString(), today.toISOString())
  const totals = await db.prepare(`SELECT COALESCE(SUM(p.amount),0) AS revenue,COUNT(DISTINCT p.order_id) AS orders FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.business_id=? AND p.branch_id=? AND p.status='COMPLETED'`).get(tenant.businessId, tenant.branchId)
  const cogs = num((await db.prepare(`SELECT COALESCE(SUM(oi.quantity*rc.quantity*i.unit_cost),0) AS value FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN recipe_components rc ON rc.menu_item_id=oi.menu_item_id AND rc.business_id=o.business_id JOIN ingredients i ON i.id=rc.ingredient_id AND i.business_id=o.business_id WHERE o.business_id=? AND o.branch_id=? AND o.status='PAID'`).get(tenant.businessId, tenant.branchId))?.value)
  const expenses = num((await db.prepare("SELECT COALESCE(SUM(amount),0) AS value FROM expenses WHERE business_id=? AND (branch_id=? OR branch_id IS NULL) AND status IN ('APPROVED','PAID')").get(tenant.businessId, tenant.branchId))?.value)
  const procurement = num((await db.prepare("SELECT COALESCE(SUM(total),0) AS value FROM purchase_orders WHERE business_id=? AND (branch_id=? OR branch_id IS NULL) AND status IN ('RECEIVED','PAID','COMPLETED')").get(tenant.businessId, tenant.branchId))?.value)
  const refunds = num((await db.prepare("SELECT COALESCE(SUM(refund_amount),0) AS value FROM sales_returns WHERE business_id=? AND branch_id=? AND status IN ('APPROVED','COMPLETED','REFUNDED')").get(tenant.businessId, tenant.branchId))?.value)
  const revenue = num(totals.revenue), grossProfit = revenue - cogs, netProfit = grossProfit - expenses, cashBalance = revenue - expenses - procurement - refunds

  const makeTrend = async (count: number) => {
    const rows = []
    for (let offset = count - 1; offset >= 0; offset--) {
      const start = new Date(today.getTime() - offset * day), end = new Date(start.getTime() + day)
      const from = start.toISOString(), to = end.toISOString()
      const row = await salesPeriod(db, tenant, from, to)
      const dayCogs = num((await db.prepare(`SELECT COALESCE(SUM(oi.quantity*rc.quantity*i.unit_cost),0) AS value FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN recipe_components rc ON rc.menu_item_id=oi.menu_item_id AND rc.business_id=o.business_id JOIN ingredients i ON i.id=rc.ingredient_id AND i.business_id=o.business_id WHERE o.business_id=? AND o.branch_id=? AND o.status='PAID' AND COALESCE(o.paid_at,o.created_at)>=$1::timestamptz AND COALESCE(o.paid_at,o.created_at)<$2::timestamptz`).get(tenant.businessId, tenant.branchId, from, to))?.value)
      const dayExpenses = num((await db.prepare("SELECT COALESCE(SUM(amount),0) AS value FROM expenses WHERE business_id=? AND (branch_id=? OR branch_id IS NULL) AND status IN ('APPROVED','PAID') AND incurred_at>=$1::timestamptz AND incurred_at<$2::timestamptz").get(tenant.businessId, tenant.branchId, from, to))?.value)
      const dayRefunds = num((await db.prepare("SELECT COALESCE(SUM(refund_amount),0) AS value FROM sales_returns WHERE business_id=? AND branch_id=? AND status IN ('APPROVED','COMPLETED','REFUNDED') AND created_at>=$1::timestamptz AND created_at<$2::timestamptz").get(tenant.businessId, tenant.branchId, from, to))?.value)
      const rev = num(row.revenue), costs = dayCogs + dayExpenses + dayRefunds
      rows.push({ date: start.toISOString().slice(0, 10), revenue: rev, orders: num(row.orders), cogs: dayCogs, expenses: dayExpenses, refunds: dayRefunds, costs, netProfit: rev - costs })
    }
    return rows
  }

  const [trend, monthlyTrend] = await Promise.all([makeTrend(7), makeTrend(30)])

  const inventory = await db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN i.quantity<=0 THEN 1 ELSE 0 END) AS out_count,SUM(CASE WHEN i.quantity>0 AND i.quantity<=i.reorder_level THEN 1 ELSE 0 END) AS low_count,COALESCE(SUM(i.quantity*i.unit_cost),0) AS stock_value FROM ingredients i WHERE i.business_id=?`).get(tenant.businessId)
  const orderCompletion = await db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN status='PAID' THEN 1 ELSE 0 END) AS completed FROM orders WHERE business_id=? AND branch_id=?").get(tenant.businessId, tenant.branchId)

  const revenueScore = clamp(50 + (pct(num(todaySales.revenue), num(yesterdaySales.revenue)) / 2))
  const cashScore = clamp(cashBalance > 0 ? 80 : cashBalance === 0 ? 50 : 20)
  const inventoryScore = clamp(num(inventory.total) ? 100 - ((num(inventory.out_count) * 18 + num(inventory.low_count) * 7) / num(inventory.total) * 100) : 100)
  const completionScore = clamp(num(orderCompletion.total) ? num(orderCompletion.completed) / num(orderCompletion.total) * 100 : 100)
  const expenseScore = clamp(revenue ? 100 - expenses / revenue * 100 : 100)
  const dimensions = [['Revenue growth', revenueScore], ['Cash flow', cashScore], ['Inventory', inventoryScore], ['Order completion', completionScore], ['Expense control', expenseScore]].map(([label, score]) => ({ label, score, grade: grade(score as number) }))
  const healthScore = clamp(dimensions.reduce((sum, item) => sum + (item.score as number), 0) / dimensions.length)

  const topProducts = await db.prepare(`SELECT oi.menu_item_id AS id,oi.name,MAX(m.image) AS image,SUM(oi.quantity) AS quantity,SUM(oi.quantity*oi.unit_price) AS revenue FROM order_items oi JOIN orders o ON o.id=oi.order_id LEFT JOIN menu_items m ON m.id=oi.menu_item_id AND m.business_id=o.business_id WHERE o.business_id=? AND o.branch_id=? AND o.status='PAID' GROUP BY oi.menu_item_id,oi.name ORDER BY revenue DESC LIMIT 4`).all(tenant.businessId, tenant.branchId)
  const revenueByCategory = await db.prepare(`SELECT COALESCE(m.category,'Other') AS name,SUM(oi.quantity*oi.unit_price) AS value FROM order_items oi JOIN orders o ON o.id=oi.order_id LEFT JOIN menu_items m ON m.id=oi.menu_item_id AND m.business_id=o.business_id WHERE o.business_id=? AND o.branch_id=? AND o.status='PAID' GROUP BY COALESCE(m.category,'Other') ORDER BY value DESC LIMIT 5`).all(tenant.businessId, tenant.branchId)
  const expensesByCategory = await db.prepare(`SELECT COALESCE(category,'Other') AS name,SUM(amount) AS value FROM expenses WHERE business_id=? AND (branch_id=? OR branch_id IS NULL) AND status IN ('APPROVED','PAID') GROUP BY COALESCE(category,'Other') ORDER BY value DESC LIMIT 5`).all(tenant.businessId, tenant.branchId)
  const customers = await db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN created_at>=NOW()-INTERVAL '30 days' THEN 1 ELSE 0 END) AS new_count FROM customers WHERE business_id=?`).get(tenant.businessId)
  const lowStock = await db.prepare(`SELECT i.id,i.name,i.sku,i.quantity,i.unit,i.reorder_level AS "reorderLevel",COALESCE(w.name,'Unassigned warehouse') AS location FROM ingredients i LEFT JOIN warehouses w ON w.id=i.warehouse_id AND w.business_id=i.business_id WHERE i.business_id=? AND i.quantity<=i.reorder_level ORDER BY (i.quantity<=0) DESC,(i.quantity/NULLIF(i.reorder_level,0)) ASC LIMIT 6`).all(tenant.businessId)

  const activities = [
    ...(await db.prepare(`SELECT p.id,'PAYMENT' AS type,'Payment received' AS title,'Order #'||o.order_number AS detail,p.amount AS amount,p.created_at AS "createdAt" FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.business_id=? AND p.branch_id=? AND p.status='COMPLETED' ORDER BY p.created_at DESC LIMIT 8`).all(tenant.businessId, tenant.branchId)),
    ...(await db.prepare(`SELECT po.id,'PURCHASE' AS type,'Purchase order '||po.po_number AS title,COALESCE(s.name,'Supplier')||' · '||po.status AS detail,po.total AS amount,po.created_at AS "createdAt" FROM purchase_orders po LEFT JOIN business_suppliers s ON s.id=po.supplier_id AND s.business_id=po.business_id WHERE po.business_id=? AND po.branch_id=? ORDER BY po.created_at DESC LIMIT 8`).all(tenant.businessId, tenant.branchId)),
  ].sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 6)

  return { generatedAt: now.toISOString(), summary: { revenue, grossProfit, netProfit, cashBalance, cogs, expenses, procurement, refunds, orders: num(totals.orders), customers: num(customers.total), newCustomers: num(customers.new_count), grossMargin: revenue ? grossProfit / revenue * 100 : 0, todayRevenue: num(todaySales.revenue), todayOrders: num(todaySales.orders), revenueChange: pct(num(todaySales.revenue), num(yesterdaySales.revenue)), orderChange: pct(num(todaySales.orders), num(yesterdaySales.orders)), stockValue: num(inventory.stock_value) }, trend, monthlyTrend, revenueByCategory, expensesByCategory, health: { score: healthScore, grade: grade(healthScore), dimensions }, inventory: { total: num(inventory.total), low: num(inventory.low_count), out: num(inventory.out_count) }, lowStock, topProducts, activities }
}
