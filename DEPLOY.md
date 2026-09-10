# Deploying Vouch

Frontend and API deploy together to **Vercel** (Hobby is enough). Postgres is
**Supabase** free tier. The indexer runs elsewhere — see §4 for why.

---

## 1. Import the repo into Vercel

1. vercel.com → **Add New → Project** → import `layinka/vouch`
2. **Framework preset: Other.** Do not let it auto-detect Angular — `vercel.json`
   already specifies the build, and the preset would override the monorepo paths.
3. Root directory: leave as the repo root (`/`), not `apps/web`.
4. Deploy.

`vercel.json` does the rest:

| Setting | Value |
|---|---|
| Build | `pnpm install && pnpm --filter web exec ng build --configuration production` |
| Output | `apps/web/dist/web/browser` |
| Function | `api/index.ts`, 60s max duration, 1024 MB |

Routing: `/health`, `/v1/*` and `/api/internal/*` hit the Express app; everything
else falls through to the Angular SPA.

---

## 2. Environment variables

Set these in **Project → Settings → Environment Variables**, for *Production*
(and Preview if you want PR deploys to work). Values are in your local `.env`.

### Required

```
SUPABASE_CONNECTION_STRING   postgresql://postgres.<ref>:<pass>@aws-1-<region>.pooler.supabase.com:6543/postgres
HEDERA_ACCOUNT_ID            0.0.10364717
HEDERA_PRIVATE_KEY           0x...            (ECDSA)
HEDERA_TOPIC_ID              0.0.10419860
X402_PAY_TO                  0.0.10364717
INTERNAL_SECRET              <from .env>
```

Use the **6543** transaction-mode pooler here, not 5432. Serverless opens a
connection per invocation and transaction mode is built for exactly that. The
direct `db.<ref>.supabase.co` host is IPv6-only and will not resolve at all.

### Required for the in-browser "buy a lookup" button

```
HEDERA_BUYER_ACCOUNT_ID      0.0.10366467
HEDERA_BUYER_PRIVATE_KEY     0x...
```

A browser has no Hedera wallet, so `POST /v1/demo/buy/:name` has the server's own
buyer agent make a real paid lookup and return the settlement receipt. Without
these the page still loads; the button just fails.

### Optional (sensible defaults exist)

```
X402_NETWORK                 hedera:testnet
X402_ASSET                   0.0.429274
X402_FACILITATOR_URL         https://api.testnet.blocky402.com
X402_PRICE_SCORE             1000
X402_PRICE_HISTORY           5000
SUBGRAPH_URL                 https://api.studio.thegraph.com/query/1758675/vouch/v0.0.1
SEPOLIA_RPC_URL              https://ethereum-sepolia-rpc.publicnode.com
```

**Do not set `SCORER_PRIVATE_KEY` or `DEPLOYER_PRIVATE_KEY` on Vercel.** Nothing
in the serverless path signs Sepolia transactions, and a write key sitting in a
public-facing runtime is a liability with no upside.

---

## 3. GitHub Actions secrets

**Repo → Settings → Secrets and variables → Actions:**

```
VOUCH_API_URL     https://<your-project>.vercel.app
INTERNAL_SECRET   same value as on Vercel
```

`.github/workflows/keepalive.yml` then runs every 10 minutes.

---

## 4. Why the cron is in GitHub Actions and not Vercel

Two hard limits, both on the free tier:

- **Vercel Hobby cron fires at most once per day.** Any expression more frequent
  is rejected at deploy time. Useless for an indexer.
- **Supabase pauses a free project after 7 days with no database activity.**
  Restoring is manual. If that happened during judging, the live demo would be a
  500 and nobody would tell you.

The Actions cron solves both: it hits `/api/internal/reindex`, which touches
Postgres and reports the last indexed block. No paid tier needed.

Verify it works:

```bash
curl -s -X POST https://<project>.vercel.app/api/internal/reindex \
  -H "x-internal-secret: $INTERNAL_SECRET"
# {"ok":true,"agents":4,"lastIndexedBlock":"11668961",...}
```

Without the header it returns 401.

---

## 5. The indexer

The indexer polls the subgraph every 45s and signs Sepolia transactions. It
cannot run on Vercel: a serverless invocation cannot hold a poll loop open, and
it needs the scorer key.

Run it from your machine while demoing:

```bash
pnpm indexer          # continuous
pnpm indexer:once     # single pass
```

This is the honest architecture — a worker is a worker — and the recording is
made locally anyway. The deployed site reads from Postgres and stays correct
whether or not the worker is running; it just stops seeing new scores.

---

## 6. After the first deploy

- [ ] `https://<project>.vercel.app/health` returns `{"ok":true,"agents":4}`
- [ ] `/agents` lists four agents with `score ●●●` withheld
- [ ] `/agents/researcher.vouch.eth` renders the permission matrix
- [ ] The **Buy reputation lookup** button returns a score and a HashScan link
- [ ] `/audit` shows HCS entries
- [ ] Actions → *reindex + keep-alive* → **Run workflow** succeeds
- [ ] **Open the site in a private window** — a logged-out judge is the real test

---

## Local development

```bash
pnpm api        # :3000
pnpm web        # :4200
pnpm indexer    # worker
pnpm mcp        # MCP server over stdio
```
