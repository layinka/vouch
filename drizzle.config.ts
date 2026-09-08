import { defineConfig } from 'drizzle-kit'

// Migrations need SESSION mode (5432), not the transaction pooler (6543):
// DDL runs in a transaction and needs a stable backend connection.
const raw = process.env.SUPABASE_CONNECTION_STRING ?? process.env.DATABASE_URL ?? ''
const url = (() => {
  if (!raw) return raw
  const u = new URL(raw)
  if (u.hostname.includes('pooler') && u.port === '6543') u.port = '5432'
  return u.toString()
})()

export default defineConfig({
  schema: './apps/api/src/db/schema.ts',
  out: './apps/api/drizzle',
  dialect: 'postgresql',
  dbCredentials: { url, ssl: { rejectUnauthorized: false } },
  verbose: true,
  strict: false,
})
