// @ts-nocheck
import { randomUUID } from 'node:crypto'

export async function initializeInventoryLink(db: any): Promise<void> {
  // Tables already created by schema.sql
}

export async function deductOrderInventory(db: any, orderId: string, tenant: any): Promise<any> {
  const order = await db.prepare('SELECT * FROM orders WHERE id=? AND business_id=? AND branch_id=?').get(orderId, tenant.businessId, tenant.branchId)
  if (!order) return { ok: false, status: 404, error: 'Order not found' }
  if (order.inventory_deducted) return { ok: true, alreadyDeducted: true }

  const requirements = await db.prepare(`
    SELECT r.ingredient_id, i.name, i.unit, i.warehouse_id,
      SUM(r.quantity * oi.quantity) AS required, i.quantity AS available
    FROM order_items oi
    JOIN recipe_components r ON r.menu_item_id=oi.menu_item_id AND r.business_id=oi.business_id
    JOIN ingredients i ON i.id=r.ingredient_id AND i.business_id=oi.business_id
    WHERE oi.order_id=? AND oi.business_id=?
    GROUP BY r.ingredient_id, i.name, i.unit, i.quantity, i.warehouse_id
  `).all(orderId, tenant.businessId)

  const shortages = requirements.filter((x: any) => x.available < x.required)
  if (shortages.length) return {
    ok: false, status: 409,
    error: `Insufficient stock: ${shortages.map((x: any) => `${x.name} (${x.available} ${x.unit} available, ${x.required} required)`).join(', ')}`,
    shortages,
  }

  try {
    await db.transaction(async (tx: any) => {
      for (const item of requirements) {
        await tx.prepare('UPDATE ingredients SET quantity=quantity-?,updated_at=NOW() WHERE id=? AND business_id=?').run(item.required, item.ingredient_id, tenant.businessId)
        await tx.prepare('INSERT INTO stock_movements(id,ingredient_id,type,quantity,reason,created_at,business_id,branch_id,warehouse_id) VALUES(?,?,?,?,?,NOW(),?,?,?)').run(randomUUID(), item.ingredient_id, 'SALE', -item.required, `Order #${order.order_number}`, tenant.businessId, tenant.branchId, item.warehouse_id)
      }
      await tx.prepare('UPDATE orders SET inventory_deducted=true WHERE id=? AND business_id=?').run(orderId, tenant.businessId)
    })
  } catch (error) { throw error }

  const alerts = await db.prepare(`
    SELECT id, name, quantity, reorder_level, unit,
      CASE WHEN quantity<=0 THEN 'OUT' WHEN quantity<=reorder_level THEN 'LOW' ELSE 'HEALTHY' END AS status
    FROM ingredients WHERE business_id=? AND quantity<=reorder_level ORDER BY quantity
  `).all(tenant.businessId)

  return { ok: true, deducted: requirements, alerts }
}
