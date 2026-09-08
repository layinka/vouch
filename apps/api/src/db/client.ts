import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema.ts'

/**
 * Supabase gives you two pooler ports and they are not interchangeable:
 *
 *   6543  transaction mode — one connection per statement. Right for serverless
 *         and for the API, but it cannot hold session state, so no named
 *         prepared statements and no DDL transactions.
 *   5432  session mode — a real session. Needed for migrations.
 *
 * The direct host (db.<ref>.supabase.co) is IPv6-only on the free tier and will
 * not resolve on most networks, so we never use it.
 */
const RAW = process.env.SUPABASE_CONNECTION_STRING ?? process.env.DATABASE_URL
if (!RAW) throw new Error('SUPABASE_CONNECTION_STRING is not set')

export function sessionModeUrl(url: string): string {
  const u = new URL(url)
  if (u.hostname.includes('pooler') && u.port === '6543') u.port = '5432'
  return u.toString()
}

export const isTransactionPooler = new URL(RAW).port === '6543'

export const pool = new pg.Pool({
  connectionString: RAW,
  ssl: { rejectUnauthorized: false },
  max: isTransactionPooler ? 4 : 8,
  idleTimeoutMillis: 20_000,
  connectionTimeoutMillis: 15_000,
  // Transaction-mode pooling hands you a different backend per statement, so a
  // named prepared statement created on one is missing on the next.
  ...(isTransactionPooler ? { statement_timeout: 20_000 } : {}),
})

pool.on('error', (err) => console.error('[db] idle client error:', err.message))

export const db = drizzle(pool, { schema })
export { schema }
