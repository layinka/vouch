import { ScoreAnchored } from '../generated/VouchScoreAnchor/VouchScoreAnchor'
import { ScoreSnapshot } from '../generated/schema'
import { loadOrCreateAgent } from './shared'

export function handleScoreAnchored(event: ScoreAnchored): void {
  let agent = loadOrCreateAgent(event.params.agentId, event.block.timestamp, event.block.number)

  let id = event.transaction.hash.toHexString() + '-' + event.logIndex.toString()
  let snap = new ScoreSnapshot(id)
  snap.agent = agent.id
  snap.score = event.params.score
  snap.evidenceRoot = event.params.evidenceRoot
  snap.components = event.params.components
  snap.timestamp = event.block.timestamp
  snap.block = event.block.number
  snap.txHash = event.transaction.hash
  snap.save()

  agent.latestScore = event.params.score
  agent.latestScoreAt = event.block.timestamp
  agent.save()
}
