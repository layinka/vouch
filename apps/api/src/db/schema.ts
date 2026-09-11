import {
  pgTable, text, integer, bigint, jsonb, timestamp, index, uniqueIndex, pgEnum, numeric,
} from 'drizzle-orm/pg-core'

/**
 * Postgres is the READ PATH. The subgraph is the source of truth, but Studio's
 * dev endpoint is capped at 3,000 queries/day — so the indexer worker is the only
 * thing that ever queries it, and everything the API and UI serve comes from here.
 */

export const outcomeEnum = pgEnum('outcome', ['Ok', 'Disputed', 'Failed'])

export const agents = pgTable(
  'agents',
  {
    /** ERC-8004 agent id — the same key the subgraph uses, so upserts are trivial */
    erc8004Id: text('erc8004_id').primaryKey(),
    ensName: text('ens_name'),
    uaid: text('uaid'),
    node: text('node'),
    resolver: text('resolver'),
    owner: text('owner'),
    /** name unregistered by its owner; it no longer resolves, so it is not listed */
    revoked: text('revoked'),

    // ---- evidence, mirrored from the subgraph ----
    totalJobs: integer('total_jobs').notNull().default(0),
    okJobs: integer('ok_jobs').notNull().default(0),
    disputedJobs: integer('disputed_jobs').notNull().default(0),
    failedJobs: integer('failed_jobs').notNull().default(0),
    uniqueCounterparties: integer('unique_counterparties').notNull().default(0),
    disputeRateBps: integer('dispute_rate_bps').notNull().default(0),
    /** wei; numeric not bigint because settled value can exceed 2^63 */
    settledValue: numeric('settled_value', { precision: 78, scale: 0 }).notNull().default('0'),

    // ---- derived by us ----
    score: integer('score'),
    components: jsonb('components').$type<Record<string, number>>(),
    verdict: text('verdict'),
    computedAt: timestamp('computed_at', { withTimezone: true }),

    // ---- proof that the score was published, not just calculated ----
    anchorTx: text('anchor_tx'),
    ensTx: text('ens_tx'),
    publishedScore: integer('published_score'),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agents_ens_name_idx').on(t.ensName),
    index('agents_score_idx').on(t.score),
  ],
)

export const attestations = pgTable(
  'attestations',
  {
    /** subgraph id: agentId-attestor-jobRef */
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    attestor: text('attestor').notNull(),
    jobRef: text('job_ref').notNull(),
    outcome: outcomeEnum('outcome').notNull(),
    value: numeric('value', { precision: 78, scale: 0 }).notNull().default('0'),
    disputeReason: text('dispute_reason'),
    disputedAt: bigint('disputed_at', { mode: 'number' }),
    timestamp: bigint('timestamp', { mode: 'number' }).notNull(),
    block: bigint('block', { mode: 'number' }).notNull(),
    txHash: text('tx_hash').notNull(),
  },
  (t) => [
    index('attestations_agent_idx').on(t.agentId),
    index('attestations_time_idx').on(t.timestamp),
  ],
)

export const scoreHistory = pgTable(
  'score_history',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    score: integer('score').notNull(),
    components: jsonb('components').$type<Record<string, number>>().notNull(),
    evidenceRoot: text('evidence_root'),
    anchorTx: text('anchor_tx'),
    ensTx: text('ens_tx'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('score_history_agent_time_idx').on(t.agentId, t.createdAt)],
)

/** Every x402-paid reputation lookup. Mirrors the HCS audit topic. */
export const lookups = pgTable(
  'lookups',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id'),
    agentName: text('agent_name'),
    payerAccount: text('payer_account').notNull(),
    asset: text('asset').notNull(),
    amount: text('amount').notNull(),
    hederaTxId: text('hedera_tx_id'),
    hcsSequence: bigint('hcs_sequence', { mode: 'number' }),
    scoreServed: integer('score_served'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('lookups_time_idx').on(t.createdAt)],
)

/** Where the indexer got to, so a restart does not replay the whole subgraph. */
export const cursors = pgTable('cursors', {
  name: text('name').primaryKey(),
  position: text('position').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
