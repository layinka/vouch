import {
  LabelRegistered, LabelUnregistered, ExpiryUpdated, ResolverUpdated,
} from '../generated/VouchRegistry/UserRegistryImpl'
import { NameRegistration } from '../generated/schema'

export function handleLabelRegistered(event: LabelRegistered): void {
  let n = new NameRegistration(event.params.tokenId.toString())
  n.label = event.params.label
  n.labelHash = event.params.labelHash
  n.owner = event.params.owner
  n.expiry = event.params.expiry
  n.registeredAt = event.block.timestamp
  n.active = true
  n.save()
}

// Revocation. The name stops resolving: demo moment C tail.
export function handleLabelUnregistered(event: LabelUnregistered): void {
  let n = NameRegistration.load(event.params.tokenId.toString())
  if (n == null) return
  n.active = false
  n.revokedAt = event.block.timestamp
  n.save()
}

export function handleExpiryUpdated(event: ExpiryUpdated): void {
  let n = NameRegistration.load(event.params.tokenId.toString())
  if (n == null) return
  n.expiry = event.params.newExpiry
  n.save()
}

export function handleResolverUpdated(event: ResolverUpdated): void {
  let n = NameRegistration.load(event.params.tokenId.toString())
  if (n == null) return
  n.resolver = event.params.resolver
  n.save()
}
