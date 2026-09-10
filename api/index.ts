/**
 * Vercel serverless entrypoint.
 *
 * Vercel's Node runtime accepts an Express app as the default export and drives
 * it per-request, so this is a thin re-export rather than a second server. The
 * app itself does not know or care which runtime it is in.
 *
 * vercel.json rewrites /v1/*, /health and /api/* here; everything else falls
 * through to the built Angular app.
 */
export { default } from '../apps/api/src/server.ts'
