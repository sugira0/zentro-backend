// @ts-nocheck
// Runs the schema.sql file against the PostgreSQL database on every startup.
// All statements are CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
// so this is safe to run repeatedly.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

export async function initSchema(db: any): Promise<void> {
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql')
  const sql = readFileSync(schemaPath, 'utf8')
  await db.exec(sql)
}
