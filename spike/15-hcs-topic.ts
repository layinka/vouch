/**
 * One-time: create the HCS audit topic. Prints the id for .env.
 * Run: node --env-file=.env spike/15-hcs-topic.ts
 */
import { createAuditTopic, hederaClient } from '../apps/api/src/hedera/hcs.ts'

if (process.env.HEDERA_TOPIC_ID) {
  console.log(`\n  HEDERA_TOPIC_ID already set: ${process.env.HEDERA_TOPIC_ID}`)
  console.log(`  https://hashscan.io/testnet/topic/${process.env.HEDERA_TOPIC_ID}\n`)
  process.exit(0)
}

console.log('\n=== Create HCS audit topic ===\n')
const id = await createAuditTopic()
console.log(`  ok    topic ${id}`)
console.log(`  https://hashscan.io/testnet/topic/${id}\n`)
console.log('  Add to .env:')
console.log(`HEDERA_TOPIC_ID=${id}\n`)
hederaClient().close()
