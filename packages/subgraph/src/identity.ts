import { Registered, MetadataSet, Transfer } from '../generated/IdentityRegistry/IdentityRegistry'
import { Agent } from '../generated/schema'
import { loadOrCreateAgent } from './shared'

export function handleRegistered(event: Registered): void {
  let a = loadOrCreateAgent(event.params.agentId, event.block.timestamp, event.block.number)
  a.owner = event.params.owner
  a.tokenURI = event.params.tokenURI
  a.registeredAt = event.block.timestamp
  a.registeredBlock = event.block.number
  a.save()
}

/**
 * ERC-8004 metadata is where Vouch stores the link back to ENS. `ens` and `node`
 * are written at registration; `uaid` follows once the HCS-14 id is derived.
 * Indexing them here is what lets one query resolve a name, a UAID and an
 * on-chain evidence trail together.
 */
export function handleMetadataSet(event: MetadataSet): void {
  let a = Agent.load(event.params.agentId.toString())
  if (a == null) return

  let key = event.params.key
  if (key == 'ens') {
    a.ensName = event.params.value.toString()
  } else if (key == 'node') {
    a.node = event.params.value
  } else if (key == 'uaid') {
    a.uaid = event.params.value.toString()
  } else {
    return
  }
  a.save()
}

export function handleTransfer(event: Transfer): void {
  let a = Agent.load(event.params.tokenId.toString())
  if (a == null) return
  a.owner = event.params.to
  a.save()
}
