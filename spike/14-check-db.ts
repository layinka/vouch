/**
 * Verifies the Supabase Postgres connection before any schema work depends on it.
 *
 * Known gotcha: Supabase's DIRECT connection (db.<ref>.supabase.co:5432) is
 * IPv6-only on the free tier. On an IPv4-only network it fails with ENETUNREACH
 * or ENOTFOUND. The fix is the connection POOLER, which is IPv4:
 *   postgresql://postgres.<ref>:<pass>@aws-0-<region>.pooler.supabase.com:6543/postgres
 * Port 6543 is transaction mode (best for serverless), 5432 is session mode
 * (needed for migrations and prepared statements).
 *
 * Run: node --env-file=.env spike/14-check-db.ts
 */
import pg from 'pg'

const RAW = process.env.SUPABASE_CONNECTION_STRING ?? process.env.DATABASE_URL
if (!RAW) {
  console.error('\n  FAIL  SUPABASE_CONNECTION_STRING not set\n')
  process.exit(1)
}

const url = new URL(RAW)
const isPooler = url.hostname.includes('pooler')
const redacted = `${url.protocol}//${url.username}:***@${url.hostname}:${url.port}${url.pathname}`

console.log('\n=== Supabase Postgres connection ===\n')
console.log(`  url       ${redacted}`)
console.log(`  mode      ${isPooler ? (url.port === '6543' ? 'pooler / transaction' : 'pooler / session') : 'DIRECT (IPv6-only on free tier)'}`)

const client = new pg.Client({
  connectionString: RAW,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
})

try {
  await client.connect()
  const { rows } = await client.query(
    `select current_database() as db,
            current_user      as usr,
            version()         as version,
            pg_size_pretty(pg_database_size(current_database())) as size`,
  )
  const r = rows[0]!
  console.log(`\n  ok        connected`)
  console.log(`  database  ${r.db}`)
  console.log(`  user      ${r.usr}`)
  console.log(`  size      ${r.size}  (free tier ceiling: 500 MB)`)
  console.log(`  version   ${String(r.version).split(' ').slice(0, 2).join(' ')}`)

  // Write test — proves we can actually create the schema, not just read.
  await client.query('create schema if not exists vouch')
  await client.query('create table if not exists vouch._conn_check (id int primary key, at timestamptz default now())')
  await client.query('insert into vouch._conn_check (id) values (1) on conflict (id) do update set at = now()')
  const { rows: check } = await client.query('select at from vouch._conn_check where id = 1')
  console.log(`  write     ok (${check[0]!.at.toISOString()})`)
  await client.query('drop table vouch._conn_check')

  console.log('\n  GATE PASSED\n')
} catch (err) {
  const msg = (err as Error).message
  console.error(`\n  FAIL  ${msg}`)
  if (/ENETUNREACH|ENOTFOUND|EAI_AGAIN/.test(msg) && !isPooler) {
    console.error('\n  This is the IPv6 problem. Swap to the pooler string:')
    console.error('    Supabase dashboard -> Project Settings -> Database -> Connection string')
    console.error('    -> choose "Session pooler" (IPv4), port 5432, then re-run.')
    console.error('    It looks like: postgresql://postgres.<ref>:<pass>@aws-0-<region>.pooler.supabase.com:5432/postgres')
  }
  if (/password authentication failed/.test(msg)) {
    console.error('\n  Password mismatch — the connection string may still contain [YOUR-PASSWORD].')
  }
  console.error()
  process.exit(1)
} finally {
  await client.end().catch(() => {})
}
