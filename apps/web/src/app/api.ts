import { Injectable, signal, computed, inject } from '@angular/core'
import { HttpClient, httpResource } from '@angular/common/http'

export type Verdict = 'trusted' | 'caution' | 'avoid' | 'unproven'

export type AgentSummary = {
  name: string
  erc8004Id: string
  uaid: string | null
  verdict: Verdict
  totalJobs: number
}

export type AgentIdentity = {
  name: string
  identity: { erc8004Id: string; uaid: string | null; node: string | null; resolver: string | null }
  claims: { endpoint: string }
  note: string
}

export type PermissionRow = { key: string; writer: 'agent' | 'scorer'; canAgentWrite: boolean }

export type Permissions = {
  name: string
  resolver: string
  records: PermissionRow[]
  enforcedBy: string
  revertsWith: string
}

export type ScoreDetail = {
  name: string
  score: number
  verdict: Verdict
  components: Record<string, number>
  evidence: {
    totalJobs: number; okJobs: number; disputedJobs: number; failedJobs: number
    uniqueCounterparties: number; disputeRateBps: number; settledValueWei: string
  }
  published: { anchorTx: string | null; ensTx: string | null }
  computedAt: string | null
}

export type AuditEntry = { seq: number; at: string; rec: Record<string, unknown> }

export const API_BASE =
  (globalThis as { __VOUCH_API__?: string }).__VOUCH_API__ ?? 'http://localhost:3000'

@Injectable({ providedIn: 'root' })
export class VouchApi {
  private readonly http = inject(HttpClient)

  /** The free directory. Deliberately carries no scores — those are the product. */
  readonly agents = httpResource<{ agents: AgentSummary[] }>(() => `${API_BASE}/v1/agents`)

  identity(name: () => string | undefined) {
    return httpResource<AgentIdentity>(() => {
      const n = name()
      return n ? `${API_BASE}/v1/agents/${n}` : undefined
    })
  }

  permissions(name: () => string | undefined) {
    return httpResource<Permissions>(() => {
      const n = name()
      return n ? `${API_BASE}/v1/agents/${n}/permissions` : undefined
    })
  }

  readonly audit = httpResource<{ topic: string | null; entries: AuditEntry[] }>(
    () => `${API_BASE}/v1/audit`,
  )

  /**
   * Scores are behind x402, so a browser cannot fetch them directly — it has no
   * Hedera wallet. The demo endpoint proxies a paid lookup performed by our own
   * buyer agent, and returns the settlement receipt alongside the score so the
   * page can show that a real payment happened.
   */
  buyScore(name: string) {
    return this.http.post<ScoreDetail & { settlement?: { payer: string; tx: string } }>(
      `${API_BASE}/v1/demo/buy/${name}`, {},
    )
  }
}
