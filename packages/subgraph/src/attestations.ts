import { Attested, Disputed } from '../generated/VouchAttestations/VouchAttestations'
import { Attestation, AgentCounterparty } from '../generated/schema'
import {
  loadOrCreateAgent, loadOrCreateCounterparty, recomputeDisputeRate,
  attestationId, pairId, stats,
} from './shared'

const OUTCOMES = ['Ok', 'Disputed', 'Failed']

export function handleAttested(event: Attested): void {
  let agent = loadOrCreateAgent(event.params.agentId, event.block.timestamp, event.block.number)
  let cp = loadOrCreateCounterparty(event.params.attestor, event.block.timestamp)

  let att = new Attestation(
    attestationId(event.params.agentId, event.params.attestor, event.params.jobRef),
  )
  att.agent = agent.id
  att.attestor = cp.id
  att.jobRef = event.params.jobRef
  att.outcome = OUTCOMES[event.params.outcome]
  att.value = event.params.valueWei
  att.timestamp = event.block.timestamp
  att.block = event.block.number
  att.txHash = event.transaction.hash
  att.save()

  // Distinct-rater tracking. Only a rater we have never seen for THIS agent
  // increments uniqueCounterparties.
  let pid = pairId(event.params.agentId, event.params.attestor)
  let pair = AgentCounterparty.load(pid)
  let isNewRater = pair == null
  if (pair == null) {
    pair = new AgentCounterparty(pid)
    pair.agent = agent.id
    pair.counterparty = cp.id
    pair.jobs = 0
    pair.firstSeen = event.block.timestamp
  }
  pair.jobs = pair.jobs + 1
  pair.save()

  agent.totalJobs = agent.totalJobs + 1
  agent.settledValue = agent.settledValue.plus(event.params.valueWei)
  if (isNewRater) agent.uniqueCounterparties = agent.uniqueCounterparties + 1

  let outcome = event.params.outcome
  if (outcome == 0) agent.okJobs = agent.okJobs + 1
  else if (outcome == 1) agent.disputedJobs = agent.disputedJobs + 1
  else agent.failedJobs = agent.failedJobs + 1

  recomputeDisputeRate(agent)
  agent.save()

  cp.attestationsGiven = cp.attestationsGiven + 1
  if (outcome == 1) cp.disputesRaised = cp.disputesRaised + 1
  cp.save()

  let g = stats()
  g.totalAttestations = g.totalAttestations + 1
  if (outcome == 1) g.totalDisputes = g.totalDisputes + 1
  g.totalSettledValue = g.totalSettledValue.plus(event.params.valueWei)
  g.save()
}

/**
 * An Ok attestation escalated to Disputed. This transition is what the demo turns
 * on: a job that already counted as good stops counting, so the score visibly
 * moves rather than simply appearing at a new value.
 */
export function handleDisputed(event: Disputed): void {
  let att = Attestation.load(
    attestationId(event.params.agentId, event.params.attestor, event.params.jobRef),
  )
  if (att == null) return

  let wasOk = att.outcome == 'Ok'
  att.outcome = 'Disputed'
  att.disputeReason = event.params.reason
  att.disputedAt = event.block.timestamp
  att.save()

  if (!wasOk) return

  let agent = loadOrCreateAgent(event.params.agentId, event.block.timestamp, event.block.number)
  agent.okJobs = agent.okJobs - 1
  agent.disputedJobs = agent.disputedJobs + 1
  recomputeDisputeRate(agent)
  agent.save()

  let cp = loadOrCreateCounterparty(event.params.attestor, event.block.timestamp)
  cp.disputesRaised = cp.disputesRaised + 1
  cp.save()

  let g = stats()
  g.totalDisputes = g.totalDisputes + 1
  g.save()
}
