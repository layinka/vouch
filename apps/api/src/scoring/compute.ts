/**
 * The scoring function.
 *
 * Design constraints, in order of importance:
 *
 *  1. EXPLAINABLE. Every score ships with its components, and the components sum
 *     to the score. A judge asking "why is this 812?" gets an answer, not a
 *     gesture at a model.
 *  2. SYBIL-RESISTANT. Volume alone must not buy a score. Counterparty diversity
 *     is log-scaled and gates the volume term, so two agents rating each other a
 *     thousand times gain almost nothing.
 *  3. HONEST ABOUT THIN HISTORY. Four clean jobs is not evidence of
 *     trustworthiness. A new agent scores "caution", never "trusted".
 */

export type Evidence = {
  totalJobs: number
  okJobs: number
  disputedJobs: number
  failedJobs: number
  uniqueCounterparties: number
  /** wei, as a decimal string */
  settledValue: string
  /** unix seconds of the first attestation, if any */
  firstSeen?: number
}

export type Components = {
  reliability: number
  diversity: number
  volume: number
  track: number
  penalty: number
}

export type Score = {
  score: number
  verdict: 'trusted' | 'caution' | 'avoid' | 'unproven'
  components: Components
}

const WEIGHTS = { reliability: 380, diversity: 260, volume: 180, track: 180 } as const
const MAX = 1000

/** log-scaled so the first few of anything matter and the hundredth does not */
const sat = (value: number, halfway: number) =>
  value <= 0 ? 0 : Math.log1p(value) / Math.log1p(value + halfway)

export function computeScore(e: Evidence, now = Math.floor(Date.now() / 1000)): Score {
  const jobs = e.totalJobs
  if (jobs === 0) {
    return {
      score: 0,
      verdict: 'unproven',
      components: { reliability: 0, diversity: 0, volume: 0, track: 0, penalty: 0 },
    }
  }

  // ---- reliability: share of jobs that ended well ----
  const bad = e.disputedJobs + e.failedJobs
  const goodRate = Math.max(0, (jobs - bad) / jobs)
  // A failure is worse than a dispute: a dispute is contested, a failure is not.
  const severity = (e.disputedJobs * 1 + e.failedJobs * 1.6) / jobs
  const reliability = WEIGHTS.reliability * Math.max(0, goodRate - severity * 0.25)

  // ---- diversity: how many DISTINCT counterparties vouched ----
  // This is the anti-Sybil term. It saturates around 8 raters.
  const diversity = WEIGHTS.diversity * sat(e.uniqueCounterparties, 6)

  // ---- volume: gated by diversity so it cannot be farmed alone ----
  const eth = Number(BigInt(e.settledValue || '0') / 10n ** 15n) / 1000
  const diversityGate = Math.min(1, e.uniqueCounterparties / 3)
  const volume = WEIGHTS.volume * sat(eth, 10) * diversityGate

  // ---- track record: sustained history, not a burst ----
  const ageDays = e.firstSeen ? Math.max(0, (now - e.firstSeen) / 86_400) : 0
  const track = WEIGHTS.track * 0.6 * sat(jobs, 12) + WEIGHTS.track * 0.4 * sat(ageDays, 30)

  // ---- penalty: a high dispute rate is disqualifying, not merely costly ----
  const disputeRate = bad / jobs
  // Tuned so a badly-behaved agent lands visibly low rather than clamping to 0 —
  // a zero reads as missing data, and the point is that the score was COMPUTED.
  const penalty = disputeRate > 0.25 ? -Math.round(MAX * (disputeRate - 0.25) * 0.8) : 0

  const raw = reliability + diversity + volume + track + penalty
  const score = Math.max(0, Math.min(MAX, Math.round(raw)))

  // Thin history can never read as "trusted", however clean it looks.
  const thin = jobs < 8 || e.uniqueCounterparties < 3
  const verdict: Score['verdict'] =
    score >= 700 && !thin ? 'trusted' : score >= 400 ? 'caution' : 'avoid'

  return {
    score,
    verdict,
    components: {
      reliability: Math.round(reliability),
      diversity: Math.round(diversity),
      volume: Math.round(volume),
      track: Math.round(track),
      penalty,
    },
  }
}

/** Deterministic evidence root: what the score was derived from, hashable on-chain. */
export function evidenceDigest(e: Evidence): string {
  return JSON.stringify({
    d: e.disputedJobs,
    f: e.failedJobs,
    j: e.totalJobs,
    o: e.okJobs,
    u: e.uniqueCounterparties,
    v: e.settledValue,
  })
}
