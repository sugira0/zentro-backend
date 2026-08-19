// @ts-nocheck
import { randomUUID } from 'node:crypto'
import { uploadToR2 } from './r2.ts'

const clean = (v: any) => String(v ?? '').trim()
const number = (v: any, fallback = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fallback }
const categoryPrefix = (cat: string) => String(Math.abs([...String(cat)].reduce((t, l) => t + l.charCodeAt(0), 0)) % 900 + 100)
const generateBarcode = (cat: string) => { const base = `041${categoryPrefix(cat)}${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 10)}`.slice(0, 12), sum = [...base].reduce((t, d, i) => t + Number(d) * (i % 2 ? 3 : 1), 0); return base + ((10 - sum % 10) % 10) }
const uniqueBarcode = async (db: any, businessId: string, category: string) => { let code = generateBarcode(category); while (await db.prepare('SELECT 1 FROM menu_items WHERE business_id=? AND barcode=?').get(businessId, code)) code = generateBarcode(category); return code }

export async function initializeProductCatalog(db: any): Promise<void> {
  // Schema already created by schema.sql — no migrations needed
}

export async function listProducts(db: any, tenant: any): Promise<any[]> {
  return db.prepare(`
    SELECT m.id,m.name,m.sku,m.description,m.category,m.price,m.cost,m.barcode,m.unit,
      m.supplier_id,m.product_status,m.reorder_level,m.track_stock,m.image,m.available,
      m.location,m.menu_kind,m.dietary_tag,m.preparation_time,m.has_variations,
      COALESCE(MIN(FLOOR(i.quantity/r.quantity)::INTEGER),0) AS stock,
      CASE WHEN m.track_stock=false OR COUNT(r.ingredient_id)=0 THEN 'UNTRACKED'
           WHEN MIN(i.quantity/r.quantity)<=0 THEN 'OUT'
           WHEN MIN(i.quantity/r.quantity)<=m.reorder_level THEN 'LOW'
           ELSE 'IN_STOCK' END AS "stockStatus"
    FROM menu_items m
    LEFT JOIN recipe_components r ON r.menu_item_id=m.id AND r.business_id=m.business_id
    LEFT JOIN ingredients i ON i.id=r.ingredient_id AND i.business_id=m.business_id
    WHERE m.business_id=? GROUP BY m.id ORDER BY m.name`).all(tenant.businessId)
}

export async function productDetail(db: any, id: number, tenant: any): Promise<any> {
  const product = await db.prepare('SELECT * FROM menu_items WHERE id=? AND business_id=?').get(id, tenant.businessId)
  if (!product) return null
  const components = await db.prepare(`
    SELECT i.id,i.name,i.sku,i.unit,i.quantity,i.reorder_level,i.unit_cost,i.warehouse_id,r.quantity AS recipe_quantity
    FROM recipe_components r JOIN ingredients i ON i.id=r.ingredient_id AND i.business_id=r.business_id
    WHERE r.menu_item_id=? AND r.business_id=? ORDER BY i.name`).all(id, tenant.businessId)
  const supplier = product.supplier_id ? await db.prepare('SELECT * FROM business_suppliers WHERE id=? AND business_id=?').get(product.supplier_id, tenant.businessId) : null
  return { ...product, components, supplier, stock: components.length ? Math.min(...components.map((x: any) => Math.floor(x.quantity / x.recipe_quantity))) : 0 }
}

export async function createProduct(db: any, input: any, tenant: any): Promise<any> {
  const name = clean(input.name), category = clean(input.category).toLowerCase()
  const price = Math.trunc(number(input.price, NaN))
  if (!name || !category || !Number.isFinite(price) || price < 0)
    return { error: 'Name, category and a valid selling price are required', status: 400 }

  const maxRow = await db.prepare('SELECT COALESCE(MAX(id),0)+1 AS id FROM menu_items').get()
  const id = Number(maxRow.id)
  const sku = clean(input.sku) || `PRD-${String(id).padStart(4, '0')}`
  const barcode = clean(input.barcode) || await uniqueBarcode(db, tenant.businessId, category)

  const duplicate = await db.prepare('SELECT id FROM menu_items WHERE business_id=? AND (lower(sku)=lower(?) OR (? IS NOT NULL AND barcode=?))').get(tenant.businessId, sku, barcode, barcode)
  if (duplicate) return { error: 'A product with this SKU or barcode already exists in this business', status: 409 }

  const warehouse = input.warehouseId
    ? await db.prepare('SELECT id,name FROM warehouses WHERE id=? AND business_id=?').get(input.warehouseId, tenant.businessId)
    : await db.prepare("SELECT id,name FROM warehouses WHERE business_id=? AND branch_id=? AND status='ACTIVE' ORDER BY created_at LIMIT 1").get(tenant.businessId, tenant.branchId)
  if (!warehouse) return { error: 'Create an active warehouse before adding stock-tracked products', status: 409 }

  const recipeLinks = Array.isArray(input.stockLinks)
    ? input.stockLinks.map((x: any) => ({ ingredientId: Number(x.ingredientId), quantity: Number(x.quantity) })).filter((x: any) => x.ingredientId > 0 && x.quantity > 0)
    : []
  const trackStock = recipeLinks.length > 0 || !(input.trackStock === false || input.trackStock === 'false')
  const initialStock = Math.max(0, number(input.stock))
  const reorderLevel = Math.max(0, number(input.reorderLevel, 5))
  const cost = Math.max(0, Math.trunc(number(input.cost)))
  const status = clean(input.status).toUpperCase() === 'DRAFT' ? 'DRAFT' : 'ACTIVE'

  // Handle image upload to R2 if base64
  let imageUrl = input.image || null
  if (imageUrl && String(imageUrl).startsWith('data:')) {
    imageUrl = await uploadToR2(imageUrl, 'products', tenant.businessId) || null
  }

  let ingredientId: number | null = null

  try {
    await db.transaction(async (tx: any) => {
      await tx.prepare(`INSERT INTO menu_items(id,name,category,price,favorite,image,available,sku,description,location,business_id,warehouse_id,barcode,unit,cost,supplier_id,product_status,reorder_level,track_stock,menu_kind,dietary_tag,preparation_time,has_variations) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, name, category, price, input.favorite ? true : false, imageUrl, status === 'ACTIVE' ? true : false, sku, clean(input.description), clean(input.location) || warehouse.name, tenant.businessId, warehouse.id, barcode, clean(input.unit) || 'Piece', cost, input.supplierId || null, status, reorderLevel, trackStock ? true : false, clean(input.menuKind).toUpperCase() === 'DRINK' ? 'DRINK' : 'FOOD', ['VEGETARIAN', 'NON_VEGETARIAN', 'VEGAN', 'EGG'].includes(clean(input.dietaryTag).toUpperCase()) ? clean(input.dietaryTag).toUpperCase() : 'NONE', Math.max(0, Math.trunc(number(input.preparationTime))), input.hasVariations ? true : false)

      if (recipeLinks.length) {
        for (const link of recipeLinks) {
          const valid = await tx.prepare('SELECT id FROM ingredients WHERE id=? AND business_id=?').get(link.ingredientId, tenant.businessId)
          if (valid) await tx.prepare('INSERT INTO recipe_components(menu_item_id,ingredient_id,quantity,business_id) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(id, link.ingredientId, link.quantity, tenant.businessId)
        }
      } else if (trackStock) {
        const maxIng = await tx.prepare('SELECT COALESCE(MAX(id),0)+1 AS id FROM ingredients').get()
        ingredientId = Number(maxIng.id)
        const inventorySku = `${sku}-STK-${tenant.businessId.slice(0, 6)}`
        const existName = await tx.prepare('SELECT 1 FROM ingredients WHERE name=? AND business_id=?').get(name, tenant.businessId)
        const inventoryName = existName ? `${name} · ${tenant.businessId.slice(0, 6)}` : name
        const supplierRow = input.supplierId ? await tx.prepare('SELECT name FROM business_suppliers WHERE id=? AND business_id=?').get(input.supplierId, tenant.businessId) : null
        await tx.prepare('INSERT INTO ingredients(id,name,sku,unit,quantity,reorder_level,unit_cost,supplier,updated_at,business_id,warehouse_id) VALUES(?,?,?,?,?,?,?,?,NOW(),?,?)').run(ingredientId, inventoryName, inventorySku, clean(input.unit) || 'Piece', initialStock, reorderLevel, cost, supplierRow?.name || null, tenant.businessId, warehouse.id)
        await tx.prepare('INSERT INTO recipe_components(menu_item_id,ingredient_id,quantity,business_id) VALUES(?,?,1,?) ON CONFLICT DO NOTHING').run(id, ingredientId, tenant.businessId)
        if (initialStock > 0) await tx.prepare('INSERT INTO stock_movements(id,ingredient_id,type,quantity,reason,created_at,business_id,branch_id,warehouse_id) VALUES(?,?,?,?,?,NOW(),?,?,?)').run(randomUUID(), ingredientId, 'RECEIVE', initialStock, 'Initial product stock', tenant.businessId, tenant.branchId, warehouse.id)
      }
    })
    return { id, sku, barcode, productStatus: status, inventoryId: ingredientId, stock: initialStock }
  } catch (error: any) {
    return { error: String(error?.message || '').includes('unique') ? 'SKU, barcode, or inventory identifier already exists' : 'Could not create the product and inventory records', status: 409 }
  }
}

export async function updateProduct(db: any, id: number, input: any, tenant: any): Promise<any> {
  const current = await db.prepare('SELECT * FROM menu_items WHERE id=? AND business_id=?').get(id, tenant.businessId)
  if (!current) return { error: 'Product not found', status: 404 }
  const name = clean(input.name ?? current.name), category = clean(input.category ?? current.category).toLowerCase()
  const price = Math.trunc(number(input.price, current.price)), cost = Math.trunc(number(input.cost, current.cost))
  if (!name || !category || price < 0 || cost < 0) return { error: 'Product name, category, price and cost must be valid', status: 400 }

  // Handle image upload to R2 if base64
  let imageUrl = input.image === undefined ? current.image : input.image
  if (imageUrl && String(imageUrl).startsWith('data:')) {
    imageUrl = await uploadToR2(imageUrl, 'products', tenant.businessId) || current.image
  }

  try {
    await db.prepare('UPDATE menu_items SET name=?,category=?,price=?,cost=?,description=?,barcode=?,unit=?,supplier_id=?,product_status=?,available=?,reorder_level=?,image=? WHERE id=? AND business_id=?').run(name, category, price, cost, input.description ?? current.description, clean(input.barcode ?? current.barcode) || null, input.unit ?? current.unit, input.supplierId ?? current.supplier_id, input.status ?? current.product_status, input.available === undefined ? current.available : Boolean(input.available), Math.max(0, number(input.reorderLevel, current.reorder_level)), imageUrl, id, tenant.businessId)
    return productDetail(db, id, tenant)
  } catch { return { error: 'SKU or barcode conflicts with another business product', status: 409 } }
}

export async function archiveProduct(db: any, id: number, tenant: any): Promise<any> {
  const result = await db.prepare("UPDATE menu_items SET available=false,product_status='ARCHIVED' WHERE id=? AND business_id=?").run(id, tenant.businessId)
  return result.changes ? { ok: true } : { error: 'Product not found', status: 404 }
}
