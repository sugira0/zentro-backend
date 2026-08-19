// @ts-nocheck
// PostgreSQL async database adapter.
// Wraps pg.Pool with a prepare().get/all/run interface that mirrors the old
// SQLite DatabaseSync API so every module stays readable while being fully async.
// SQLite ? placeholders are automatically converted to PostgreSQL $1 $2 ... params.
// Usage (identical call-site to old code, just with await):
//   const row  = await db.prepare('SELECT * FROM users WHERE id=?').get(id)
//   const rows = await db.prepare('SELECT * FROM users').all()
//   const res  = await db.prepare('INSERT INTO users VALUES(?,?)').run(id,name)
//   await db.exec('CREATE TABLE ...')
//   await db.transaction(async (db) => { await db.prepare(...).run(...) })

import pg from 'pg'
const { Pool } = pg

// Convert SQLite positional ? to PostgreSQL $1 $2 ...
function toPostgres(sql: string): string {
  let i = 0
  return sql.replace(/\?/g, () => `$${++i}`)
}

// Normalise a pg result row so booleans come back as JS booleans and integer
// columns that were SQLite INTEGER 0/1 booleans are preserved as numbers
// (so existing if(row.available) checks keep working).
function normalise(row: Record<string, any>): Record<string, any> {
  if (!row) return row
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(row)) {
    // pg returns JS numbers for integer columns and strings for text — keep as-is
    out[k] = v
  }
  return out
}

class Statement {
  constructor(private pool: pg.Pool, private sql: string) {}

  private pgSql() { return toPostgres(this.sql) }

  async get(...params: any[]): Promise<any> {
    const flat = params.flat()
    const { rows } = await this.pool.query(this.pgSql(), flat)
    return rows[0] ? normalise(rows[0]) : null
  }

  async all(...params: any[]): Promise<any[]> {
    const flat = params.flat()
    const { rows } = await this.pool.query(this.pgSql(), flat)
    return rows.map(normalise)
  }

  async run(...params: any[]): Promise<{ changes: number; lastInsertRowid: any }> {
    const flat = params.flat()
    const { rowCount, rows } = await this.pool.query(this.pgSql(), flat)
    return { changes: rowCount ?? 0, lastInsertRowid: rows[0]?.id ?? null }
  }
}

class TransactionDb {
  constructor(private client: pg.PoolClient) {}

  prepare(sql: string) {
    const client = this.client
    const pgSql = toPostgres(sql)
    return {
      async get(...params: any[]) {
        const flat = params.flat()
        const { rows } = await client.query(pgSql, flat)
        return rows[0] ? normalise(rows[0]) : null
      },
      async all(...params: any[]) {
        const flat = params.flat()
        const { rows } = await client.query(pgSql, flat)
        return rows.map(normalise)
      },
      async run(...params: any[]) {
        const flat = params.flat()
        const { rowCount, rows } = await client.query(pgSql, flat)
        return { changes: rowCount ?? 0, lastInsertRowid: rows[0]?.id ?? null }
      }
    }
  }

  async exec(sql: string) {
    // Execute multi-statement DDL (split on ; for safety)
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean)
    for (const stmt of statements) {
      await this.client.query(stmt)
    }
  }
}

export class Database {
  private pool: pg.Pool

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      ssl: connectionString.includes('sslmode=require') || connectionString.includes('neon.tech')
        ? { rejectUnauthorized: false }
        : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    })
    this.pool.on('error', (err) => console.error('[pg] pool error', err))
  }

  prepare(sql: string): Statement {
    return new Statement(this.pool, sql)
  }

  async exec(sql: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      // Split on ; to handle multi-statement DDL blocks
      const statements = sql.split(';').map(s => s.trim()).filter(Boolean)
      for (const stmt of statements) {
        await client.query(stmt)
      }
    } finally {
      client.release()
    }
  }

  async transaction<T>(fn: (db: TransactionDb) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const txDb = new TransactionDb(client)
      const result = await fn(txDb)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  // For raw pool access when needed (e.g. platform-backups)
  get pgPool(): pg.Pool { return this.pool }

  async end(): Promise<void> { await this.pool.end() }
}

// Singleton — imported by server.ts and passed to every module
let _db: Database | null = null
export function getDb(): Database {
  if (!_db) throw new Error('Database not initialised — call initDb() first')
  return _db
}
export function initDb(connectionString: string): Database {
  _db = new Database(connectionString)
  return _db
}
