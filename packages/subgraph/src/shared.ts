import { BigInt, Bytes, Address } from '@graphprotocol/graph-ts'
import { Agent, Counterparty, GlobalStats } from '../generated/schema'

export const GLOBAL = 'global'

export function stats(): GlobalStats {
  let g = GlobalStats.load(GLOBAL)
  if (g == null) {
    g = new GlobalStats(GLOBAL)
    g.totalAgents = 0
    g.totalAttestations = 0
    g.totalDisputes = 0
    g.totalCounterparties = 0
    g.totalSettledValue = BigInt.zero()
  }
  return g as GlobalStats
}

/**
 * An attestation can reference an agent before we have seen its Registered event
 * (separate data sources, separate start blocks), so create a shell rather than
 * dropping the evidence on the floor.
 */
export function loadOrCreateAgent(agentId: BigInt, timestamp: BigInt, block: BigInt): Agent {
  let id = agentId.toString()
  let a = Agent.load(id)
  if (a != null) return a as Agent

  a = new Agent(id)
  a.owner = Address.zero()
  a.tokenURI = ''
  a.registeredAt = timestamp
  a.registeredBlock = block
  a.totalJobs = 0
  a.okJobs = 0
  a.disputedJobs = 0
  a.failedJobs = 0
  a.settledValue = BigInt.zero()
  a.uniqueCounterparties = 0
  a.disputeRateBps = 0
  a.save()

  let g = stats()
  g.totalAgents = g.totalAgents + 1
  g.save()
  return a as Agent
}

export function loadOrCreateCounterparty(addr: Bytes, timestamp: BigInt): Counterparty {
  let id = addr.toHexString()
  let c = Counterparty.load(id)
  if (c != null) return c as Counterparty

  c = new Counterparty(id)
  c.attestationsGiven = 0
  c.disputesRaised = 0
  c.firstSeen = timestamp
  c.save()

  let g = stats()
  g.totalCounterparties = g.totalCounterparties + 1
  g.save()
  return c as Counterparty
}

/** Dispute rate in basis points. Disputed and Failed both count against the agent. */
export function recomputeDisputeRate(a: Agent): void {
  if (a.totalJobs == 0) {
    a.disputeRateBps = 0
    return
  }
  let bad = a.disputedJobs + a.failedJobs
  a.disputeRateBps = (bad * 10000) / a.totalJobs
}

export function attestationId(agentId: BigInt, attestor: Bytes, jobRef: Bytes): string {
  return agentId.toString() + '-' + attestor.toHexString() + '-' + jobRef.toHexString()
}

/**
 * Tracks distinct raters per agent. This is the anti-Sybil signal: two colluding
 * agents rating each other repeatedly never widen the spread, so volume alone
 * cannot buy a score.
 */
export function pairId(agentId: BigInt, attestor: Bytes): string {
  return agentId.toString() + '-' + attestor.toHexString()
}
