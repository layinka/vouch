# Vouch

**The passport and credit bureau for AI agents.**

An AI agent can tell you anything about itself. Vouch makes it structurally
incapable of lying about what it has *done*.

> **Claims are free. Evidence costs a tenth of a cent.**

| | |
|---|---|
| **Live demo** | https://vouch-web-three.vercel.app |
| **Subgraph** | https://api.studio.thegraph.com/query/1758675/vouch/v0.0.1 |
| **HCS audit trail** | [topic `0.0.10419860`](https://hashscan.io/testnet/topic/0.0.10419860) |
| Networks | Ethereum Sepolia · Hedera testnet |

---

## The idea in one table

Every agent gets an ENSv2 subname under `vouch.eth` with its own Permissioned
Resolver. Write access is split **per text record**:

| Record | Agent key | Scorer key |
|---|:---:|:---:|
| `agent:endpoint` | ✅ | ✗ |
| `agent:capabilities` | ✅ | ✗ |
| `agent:price` | ✅ | ✗ |
| **`agent:score`** | **✗** | **✅** |
| `agent:disputes` | ✗ | ✅ |
| `agent:volume` | ✗ | ✅ |

The agent controls what it *claims*. It cannot touch what it has *done*. That is
not enforced by our backend — it is ENSv2 Enhanced Access Control, and an
unauthorised write **reverts on-chain** with `EACUnauthorizedAccountRoles`.

The live demo has a button that proves it: it signs a real transaction with the
agent's own key, broadcasts it to Sepolia, and shows you the failure.

---

## How it qualifies, per track

### ENS — Best Use of ENSv2

| Requirement | Where |
|---|---|
| Built on ENSv2 Sepolia | [`spike/09-deploy-parent.ts`](spike/09-deploy-parent.ts) |
| Own subname registry via VerifiableFactory | UserRegistry proxy [`0x72C8b9f1…12c5`](https://sepolia.etherscan.io/address/0x72C8b9f1a462b199d3e73D7Ea74174405Cb112c5) |
| Permissioned Resolver per agent | one per agent — see table below |
| **Enhanced Access Control, per text key** | `authorizeTextRoles()` in [`spike/10-agent-identity.ts`](spike/10-agent-identity.ts) |
| Non-transferable, expiring subnames | `ROLE_CAN_TRANSFER_ADMIN` deliberately withheld from the role bitmap |
| Revocable | `unregister()` in [`apps/agents/src/revoke.ts`](apps/agents/src/revoke.ts) — owner and resolver both go to zero |
| AI agents as namespaces | every agent is a subname with its own resolver and role split |
| Functional, not hard-coded | the revert is a live broadcast; scores are indexed, never seeded |

ENSv2 has no soulbound flag — **non-transferability is the absence of
`ROLE_CAN_TRANSFER_ADMIN`**, which is why it is granted nowhere in this repo.

### The Graph — Composable / Standardized + AI Tooling

| Requirement | Where |
|---|---|
| Live data from Subgraph Studio, no mocks | [`packages/subgraph/`](packages/subgraph/), queried by the indexer only |
| Standardized schema | entities follow **ERC-8004** registry semantics — [`schema.graphql`](packages/subgraph/schema.graphql) |
| Composed products | Subgraph + an MCP server over it |
| Reusable infrastructure, not one app | [`apps/mcp/`](apps/mcp/) — four tools, usable from any MCP host |
| x402 pay-per-query | `vouch_lookup` and `vouch_history` settle in USDC per call |
| Meaningful work on the data | scoring in [`apps/api/src/scoring/compute.ts`](apps/api/src/scoring/compute.ts) |

Entity shapes deliberately follow ERC-8004 rather than a schema of our own, so a
query written against Vouch reads **any** ERC-8004 deployment on any chain.

### Hedera — AI & Agentic Payments

| Requirement | Where |
|---|---|
| Live x402-gated service on testnet | `GET /v1/agents/:name/score` — [`apps/api/src/server.ts`](apps/api/src/server.ts) |
| Settled through **Blocky402** | `https://api.testnet.blocky402.com` |
| Agent consuming it, real paid request | [`apps/agents/src/marketplace.ts`](apps/agents/src/marketplace.ts) |
| Per-call metering, not flat fees | $0.001 per score, $0.005 per history |
| **ERC-8004 + HCS-14 identity** | UAID derivation in [`spike/11-erc8004-uaid.ts`](spike/11-erc8004-uaid.ts) |
| **Verifiable audit trail on HCS** | topic [`0.0.10419860`](https://hashscan.io/testnet/topic/0.0.10419860) |
| Agent discovery directory | `GET /v1/agents` — free, and deliberately withholds scores |

Hedera's x402 flow is a **partially-signed `TransferTransaction`**: the client
signs, the facilitator countersigns as fee payer and submits. The buyer never
pays gas and never holds an API key.

---

## Architecture

The Graph does not index Hedera. That single fact determines the split:

```
ETHEREUM SEPOLIA — identity + evidence        HEDERA TESTNET — money + audit
  ENSv2 registry + resolvers                    x402 settlement (Blocky402)
  ERC-8004 registries                           HCS audit topic
  VouchAttestations / VouchScoreAnchor          USDC 0.0.429274
            |                                             |
            +--> Graph subgraph --> Postgres <-- Mirror Node REST
                                       |
                            Vouch API (x402-gated)
                               |            |
                        Angular 22 UI    MCP server
```

Identity and its evidence live where the indexing ecosystem is. Settlement lives
where finality is three seconds and fees are sub-cent.

**The loop:** attestation on Sepolia → subgraph → score recomputed → scorer
writes it to the agent's ENS record → a buyer agent reads it and decides.
Change the evidence on-chain and every number above changes with it.

---

## Deployed

**Sepolia**

| Contract | Address |
|---|---|
| UserRegistry (ours, via VerifiableFactory) | [`0x72C8b9f1…12c5`](https://sepolia.etherscan.io/address/0x72C8b9f1a462b199d3e73D7Ea74174405Cb112c5) |
| VouchAttestations | [`0xc2af33b4…0cc5`](https://sepolia.etherscan.io/address/0xc2af33b46d51d2e65d5d11e7039f4c47e8ae0cc5) |
| VouchScoreAnchor | [`0x74274467…d050`](https://sepolia.etherscan.io/address/0x742744678e8aa910b926d239c221d6d44a31d050) |
| ERC-8004 IdentityRegistry | `0x7177a686…dd09A` (reference deployment, not ours) |

**Agents** — each with its own Permissioned Resolver:

| Name | ERC-8004 | Resolver |
|---|---|---|
| `advisor.vouch.eth` | 208 | [`0xcbC95743…9aF4`](https://sepolia.etherscan.io/address/0xcbC957433EE1C33ea95cA9EEd0838C62cA2F9aF4) |
| `analyst.vouch.eth` | 207 | [`0x84C55750…1c41`](https://sepolia.etherscan.io/address/0x84C557500Ac3198032A6A23C9f5f62972F421c41) |
| `researcher.vouch.eth` | 202 | [`0x3D1aFd78…c4F6`](https://sepolia.etherscan.io/address/0x3D1aFd78e75e5007267EddAb2680328dADa6c4F6) |
| `pricefeed.vouch.eth` | 203 | [`0xF64391A3…d6eb`](https://sepolia.etherscan.io/address/0xF64391A362Fa81cfC518E55Fb3FA53338081d6eb) |
| `trader.vouch.eth` | 204 | [`0x4c5A0481…a0F8`](https://sepolia.etherscan.io/address/0x4c5A0481675bd95f627eb68E33018F24c92Aa0F8) |
| `summarizer.vouch.eth` | 205 | [`0x886F2539…1644`](https://sepolia.etherscan.io/address/0x886F25392b9d3AbFF03d1343658316Edf1821644) |
| `rogue.vouch.eth` | 206 | **revoked** — no longer resolves |

**Hedera testnet** — service `0.0.10364717` · buyer agent `0.0.10366467` ·
audit topic `0.0.10419860` · USDC `0.0.429274`

---

## Run it

```bash
pnpm install
cp .env.example .env          # fill in — see DEPLOY.md
pnpm db:migrate

pnpm api                      # :3000  x402-gated API
pnpm web                      # :4200  Angular 22 UI
pnpm indexer                  # subgraph -> score -> on-chain
pnpm mcp                      # MCP server (stdio)
```

Verify the stack end to end without touching the UI:

```bash
pnpm spike:env                # Hedera reachable, key is ECDSA
pnpm demo:marketplace         # buyer agent pays, refuses, hires
```

Deployment, environment variables and the cron that keeps the demo alive:
[`DEPLOY.md`](DEPLOY.md). MCP tools and client config: [`apps/mcp/README.md`](apps/mcp/README.md).

---

## Stack

Node 24 with native TypeScript (no build step) · Express 5 · Drizzle + Postgres
· Angular 22 (zoneless, signals) · Hardhat 3 · viem · `@hiero-ledger/sdk` ·
`@x402/{core,express,fetch,hedera}` · The Graph
