# Vouch MCP Server

Reputation for AI agents, in any MCP host.

This is **reusable infrastructure, not an app**. It lets Claude, Cursor, or any
MCP client answer the question a delegating agent actually has — *should I trust
this counterparty with money?* — without knowing anything about ENS, ERC-8004,
The Graph or Hedera.

## Tools

| Tool | Cost | What it does |
|---|---|---|
| `vouch_lookup` | $0.001 | Identity + trust score + the evidence behind it |
| `vouch_compare` | $0.001 each | Rank candidates against a hiring mandate |
| `vouch_verify_permissions` | free | Which key may write which record, and what reverts |
| `vouch_history` | $0.005 | Every job outcome, counterparty, and Ethereum tx |

Paid tools settle in USDC on Hedera over **x402**, through the Blocky402
facilitator. There is no API key anywhere in the chain: when the server answers
`402`, the tool builds and signs the payment, retries, and returns the answer
with its settlement transaction id. **An MCP tool call that pays for itself.**

The spend mandate travels with the client:

```ts
.setSpendControls({
  maxAmountPerPayment: '$0.10',
  allowedAssets: [{ network: 'hedera:testnet', asset: '0.0.429274', maxAmountPerPayment: '50000' }],
})
```

A prompt-injected agent cannot talk this client into paying an unexpected asset
or exceeding its per-call cap. The controls are enforced before a payload is
even built.

## Run it

```bash
pnpm mcp                # stdio  (for Claude Desktop / Cursor)
pnpm mcp:http           # HTTP   on :3010/mcp
```

Requires a running Vouch API (`pnpm api`) and, for the paid tools, Hedera
credentials in `.env`. Without credentials the free tools still work and the
paid ones say so rather than failing.

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "vouch": {
      "command": "node",
      "args": ["--env-file=.env", "apps/mcp/src/server.ts"],
      "cwd": "/absolute/path/to/vouch",
      "env": { "VOUCH_API_URL": "http://localhost:3000" }
    }
  }
}
```

## Sample output

`vouch_verify_permissions("researcher.vouch.eth")` — free:

```
  agent  CAN write     agent:endpoint       (owner: agent)
  agent  CAN write     agent:capabilities   (owner: agent)
  agent  CANNOT write  agent:score          (owner: scorer)
  agent  CANNOT write  agent:disputes       (owner: scorer)

Enforced by: ENSv2 Enhanced Access Control, per text key, on the PermissionedResolver
Unauthorised writes revert with: EACUnauthorizedAccountRoles

The agent controls what it claims. It cannot write what it has done.
```

`vouch_compare([...])` — three real paid lookups:

```
Mandate: score >= 600, dispute rate <= 20%

  REJECT  researcher.vouch.eth     score 524 < 600; disputes 40.0% > 20%
  PASS    summarizer.vouch.eth     CAUTION (683/1000)
  REJECT  trader.vouch.eth         score 196 < 600; disputes 60.0% > 20%

Recommended: summarizer.vouch.eth (683)
Paid $0.003 USDC on Hedera for 3 lookups.
```

`vouch_lookup("researcher.vouch.eth")` returns the score, the components that
produced it (they sum to the score, so it is auditable rather than a black box),
the identity triple, and the settlement receipt:

```
researcher.vouch.eth — CAUTION (524/1000)

Evidence (indexed from Ethereum Sepolia, not self-reported):
  jobs 15 · disputed 6 · distinct counterparties 5 · dispute rate 40.0%

Score components:
  reliability 190 · diversity 187 · volume 152 · track 114 · penalty -120

Paid $0.001 USDC on Hedera. Settlement: 0.0.7162784@1788969463.268049551
Score published on-chain: 0x585d8d23…
```

## Where the data comes from

```
Sepolia attestations -> Graph subgraph -> Postgres -> score -> ENS text record
                                                        |
                                             Vouch API (x402-gated)
                                                        |
                                                  this MCP server
```

Nothing here is self-reported. Change the evidence on-chain and every answer
above changes with it.
