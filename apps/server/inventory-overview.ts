// @ts-nocheck
const send = (r: any, s: number, v: any) => { const b = JSON.stringify(v); r.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); r.end(b) }

export async function handleInventoryOverview(req: any, res: any, url: any, db: any, t: any): Promise<boolean> {
  if (req.method !== 'GET' || url.pathname !== '/api/inventory-overview') return false

  const products = await db.prepare(`
    SELECT m.id, m.name, m.sku, m.category, m.image, m.available, m.location, m.price,
      COALESCE(MIN(CASE WHEN r.quantity>0 THEN FLOOR(i.quantity/r.quantity)::INTEGER END), 0) AS stock,
      COALESCE(SUM(r.quantity*i.unit_cost), 0) AS "unitCost",
      CASE WHEN COUNT(r.ingredient_id)=0 THEN 'UNTRACKED'
           WHEN MIN(i.quantity/r.quantity)<=0 THEN 'OUT'
           WHEN MIN(i.quantity/r.quantity)<=5 THEN 'LOW'
           ELSE 'IN_STOCK' END AS "stockStatus"
    FROM menu_items m
    LEFT JOIN recipe_components r ON r.menu_item_id=m.id AND r.business_id=m.business_id
    LEFT JOIN ingredients i ON i.id=r.ingredient_id AND i.business_id=m.business_id
    WHERE m.business_id=? GROUP BY m.id ORDER BY m.name`).all(t.businessId)

  const movements = await db.prepare(`
    SELECT m.type, COUNT(*) AS count, COALESCE(SUM(ABS(m.quantity)),0) AS quantity
    FROM stock_movements m WHERE m.business_id=? AND m.branch_id=? GROUP BY m.type`).all(t.businessId, t.branchId)

  const warehouses = await db.prepare(`
    SELECT w.id, w.name, COUNT(DISTINCT m.id) AS products,
      COALESCE(SUM(i.quantity*i.unit_cost),0) AS value
    FROM warehouses w
    LEFT JOIN ingredients i ON i.warehouse_id=w.id AND i.business_id=w.business_id
    LEFT JOIN recipe_components r ON r.ingredient_id=i.id AND r.business_id=i.business_id
    LEFT JOIN menu_items m ON m.id=r.menu_item_id AND m.business_id=r.business_id
    WHERE w.business_id=? AND w.branch_id=? GROUP BY w.id ORDER BY value DESC`).all(t.businessId, t.branchId)

  const summary = {
    products: products.length,
    value: Math.round(products.reduce((n: number, x: any) => n + x.stock * x.unitCost, 0)),
    inStock: products.filter((x: any) => x.stockStatus === 'IN_STOCK').length,
    low: products.filter((x: any) => x.stockStatus === 'LOW').length,
    out: products.filter((x: any) => x.stockStatus === 'OUT').length,
    active: products.filter((x: any) => x.available).length,
    inactive: products.filter((x: any) => !x.available).length,
  }

  return send(res, 200, { products, summary, warehouses, movements }), true
}
