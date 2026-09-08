/**
 * HCS audit trail.
 *
 * Every paid reputation lookup is written to a Hedera Consensus Service topic as
 * a consensus-timestamped record. This is what makes "verifiable payment audit
 * trails on HCS" real rather than a claim: anyone can replay the topic from the
 * public mirror node and reconstruct every score Vouch ever sold, who paid for
 * it, and what they were told.
 *
 * Two rules learned the hard way:
 *   - Never block an HTTP response on an HCS write. Consensus takes a few
 *     seconds; the queue below absorbs that.
 *   - Never read back immediately. The mirror node lags consensus by 2-10s, so
 *     Postgres is the read path and HCS reconciles behind it.
 */
import {
  Client, AccountId, PrivateKey, Hbar,
  TopicCreateTransaction, TopicMessageSubmitTransaction,
} from '@hiero-ledger/sdk'

const MIRROR = process.env.HEDERA_MIRROR_URL ?? 'https://testnet.mirrornode.hedera.com/api/v1'

export type AuditRecord =
  | { t: 'lookup'; agent: string; score: number; payer: string; amount: string; asset: string; tx?: string }
  | { t: 'anchor'; root: string; agents: number }
  | { t: 'dispute'; agent: string; attestor: string; jobRef: string }

let client: Client | null = null
let operatorKey: PrivateKey | null = null

export function hederaClient(): Client {
  if (client) return client
  const id = process.env.HEDERA_ACCOUNT_ID
  const key = process.env.HEDERA_PRIVATE_KEY
  if (!id || !key) throw new Error('HEDERA_ACCOUNT_ID / HEDERA_PRIVATE_KEY not set')
  operatorKey = PrivateKey.fromStringECDSA(key)
  client = Client.forTestnet().setOperator(AccountId.fromString(id), operatorKey)
  client.setDefaultMaxTransactionFee(new Hbar(5))
  return client
}

/** One-time. Returns the new topic id; store it in HEDERA_TOPIC_ID. */
export async function createAuditTopic(memo = 'vouch/v1/audit'): Promise<string> {
  const c = hederaClient()
  const receipt = await (
    await new TopicCreateTransaction()
      .setTopicMemo(memo)
      .setSubmitKey(operatorKey!.publicKey) // only we write; anyone reads
      .setMaxTransactionFee(new Hbar(5))
      .execute(c)
  ).getReceipt(c)
  return receipt.topicId!.toString()
}

// ---------------------------------------------------------------- write queue
type Queued = { rec: AuditRecord; tries: number }
const queue: Queued[] = []
let draining = false

async function drain() {
  if (draining) return
  draining = true
  const topicId = process.env.HEDERA_TOPIC_ID
  try {
    while (queue.length) {
      const item = queue[0]!
      if (!topicId) { queue.shift(); continue }
      try {
        const c = hederaClient()
        const receipt = await (
          await new TopicMessageSubmitTransaction()
            .setTopicId(topicId)
            // Keep under 1024 bytes or the SDK chunks it across several
            // consensus messages and reassembly becomes our problem.
            .setMessage(JSON.stringify(item.rec))
            .execute(c)
        ).getReceipt(c)
        queue.shift()
        onWritten?.(item.rec, receipt.topicSequenceNumber?.toString() ?? null)
      } catch (err) {
        item.tries++
        if (item.tries >= 3) {
          console.error('[hcs] dropping after 3 tries:', (err as Error).message)
          queue.shift()
        } else {
          await new Promise((r) => setTimeout(r, 1500 * item.tries))
        }
      }
    }
  } finally {
    draining = false
  }
}

let onWritten: ((rec: AuditRecord, seq: string | null) => void) | undefined
export function onAuditWritten(fn: typeof onWritten) { onWritten = fn }

/** Fire and forget. Returns immediately; the write happens behind the response. */
export function audit(rec: AuditRecord): void {
  queue.push({ rec, tries: 0 })
  void drain()
}

// ---------------------------------------------------------------- read
export async function readAudit(limit = 50): Promise<{ seq: number; at: string; rec: AuditRecord }[]> {
  const topicId = process.env.HEDERA_TOPIC_ID
  if (!topicId) return []
  const res = await fetch(`${MIRROR}/topics/${topicId}/messages?limit=${limit}&order=desc`)
  if (!res.ok) return []
  const body = (await res.json()) as {
    messages?: { sequence_number: number; consensus_timestamp: string; message: string }[]
  }
  const out: { seq: number; at: string; rec: AuditRecord }[] = []
  for (const m of body.messages ?? []) {
    try {
      out.push({
        seq: m.sequence_number,
        at: m.consensus_timestamp,
        rec: JSON.parse(Buffer.from(m.message, 'base64').toString('utf8')) as AuditRecord,
      })
    } catch { /* skip malformed */ }
  }
  return out
}

export const hashscanTopic = () =>
  process.env.HEDERA_TOPIC_ID
    ? `https://hashscan.io/testnet/topic/${process.env.HEDERA_TOPIC_ID}`
    : null
