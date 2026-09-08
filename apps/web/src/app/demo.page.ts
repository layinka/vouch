import { Component, inject, signal, OnDestroy, ChangeDetectionStrategy } from '@angular/core'
import { VouchApi, API_BASE, type AgentSummary, type ScoreDetail } from './api'

type Assessed = {
  name: string
  score: ScoreDetail
  settlement?: { payer: string; hashscan: string }
  eligible: boolean
  reasons: string[]
}

/**
 * The live demo. A buyer agent with a mandate discovers candidates, pays for
 * evidence on each, and refuses the ones that fail its rules.
 *
 * Every payment here is real: $0.001 USDC settled on Hedera through Blocky402,
 * with a HashScan link per lookup. The SSE stream underneath means a score that
 * changes on-chain visibly moves on this page without a refresh.
 */
@Component({
  selector: 'vouch-demo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    h1 { font-size: 28px; margin: 0 0 6px; }
    .sub { color: var(--dim); margin: 0 0 22px; }
    .mandate { display: flex; gap: 22px; flex-wrap: wrap; font-size: 13px; margin-bottom: 22px; }
    .mandate div span { color: var(--dim); }
    .log { font-family: var(--mono); font-size: 13px; line-height: 1.75; }
    .log .l { display: block; white-space: pre-wrap; word-break: break-word; }
    .l.ok   { color: var(--ok); }
    .l.bad  { color: var(--bad); }
    .l.dim  { color: var(--dim); }
    .l.head { color: var(--fg); font-weight: 600; margin-top: 10px; }
    .live { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--dim); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); }
    .dot.on { background: var(--ok); box-shadow: 0 0 0 4px rgba(79,227,156,.15); }
    .toolbar { display: flex; align-items: center; gap: 14px; margin-bottom: 20px; }
    .flash { animation: flash 1.4s ease-out; }
    @keyframes flash { from { background: rgba(242,96,122,.25); } to { background: transparent; } }
  `,
  template: `
    <div class="wrap">
      <h1>Live marketplace</h1>
      <p class="sub">A buyer agent hires a seller. No human in the loop.</p>

      <div class="mandate">
        <div><span>min score</span> {{ mandate.minScore }}</div>
        <div><span>max dispute rate</span> {{ mandate.maxDisputeRateBps / 100 }}%</div>
        <div><span>min counterparties</span> {{ mandate.minCounterparties }}</div>
      </div>

      <div class="toolbar">
        <button class="primary" (click)="run()" [disabled]="running()">
          {{ running() ? 'running…' : 'Run the buyer agent' }}
        </button>
        <span class="live"><span class="dot" [class.on]="live()"></span> live score feed</span>
      </div>

      <div class="panel log" [class.flash]="flash()">
        @for (l of lines(); track $index) {
          <span class="l" [class]="l.kind">{{ l.text }}</span>
        }
        @if (!lines().length) {
          <span class="l dim">Press run. Each lookup is a real USDC payment on Hedera testnet.</span>
        }
      </div>
    </div>
  `,
})
export class DemoPage implements OnDestroy {
  private readonly api = inject(VouchApi)

  readonly mandate = { minScore: 600, maxDisputeRateBps: 2000, minCounterparties: 3 }
  readonly lines = signal<{ text: string; kind: string }[]>([])
  readonly running = signal(false)
  readonly live = signal(false)
  readonly flash = signal(false)

  private es?: EventSource

  constructor() {
    // Live feed: when the indexer republishes a score after a dispute, it shows
    // up here without a refresh. That is demo moment C.
    this.es = new EventSource(`${API_BASE}/v1/events`)
    this.es.addEventListener('ready', () => this.live.set(true))
    this.es.addEventListener('score', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as
        { name: string; from: number; to: number; verdict: string }
      const dir = d.to < d.from ? 'DROPPED' : 'rose'
      this.push(`  ⚡ ${d.name} score ${dir} ${d.from} → ${d.to} (${d.verdict})`,
                d.to < d.from ? 'bad' : 'ok')
      this.flash.set(true)
      setTimeout(() => this.flash.set(false), 1500)
    })
    this.es.onerror = () => this.live.set(false)
  }

  ngOnDestroy() { this.es?.close() }

  private push(text: string, kind = '') {
    this.lines.update((l) => [...l, { text, kind }])
  }

  async run() {
    this.running.set(true)
    this.lines.set([])
    this.push('▸ discovering candidates (free directory, no scores)', 'head')

    const dir = await fetch(`${API_BASE}/v1/agents`).then((r) => r.json()) as { agents: AgentSummary[] }
    for (const a of dir.agents) this.push(`    found  ${a.name}`, 'dim')

    const assessed: Assessed[] = []
    let spent = 0

    for (const a of dir.agents) {
      this.push(`▸ ${a.name} — paying $0.001 for evidence…`, 'head')
      try {
        const r = await fetch(`${API_BASE}/v1/demo/buy/${a.name}`, { method: 'POST' })
        if (!r.ok) { this.push(`    payment failed (HTTP ${r.status})`, 'bad'); continue }
        const score = await r.json() as ScoreDetail & { settlement?: { payer: string; hashscan: string } }
        spent += 0.001

        if (score.settlement) this.push(`    settled  ${score.settlement.hashscan}`, 'dim')
        this.push(`    score    ${score.score} (${score.verdict})`, 'dim')
        this.push(`    evidence ${score.evidence.totalJobs} jobs · ` +
                  `${score.evidence.disputedJobs} disputed · ${score.evidence.failedJobs} failed · ` +
                  `${score.evidence.uniqueCounterparties} counterparties`, 'dim')

        const reasons: string[] = []
        if (score.score < this.mandate.minScore) reasons.push(`score ${score.score} < ${this.mandate.minScore}`)
        if (score.evidence.disputeRateBps > this.mandate.maxDisputeRateBps) {
          reasons.push(`dispute rate ${(score.evidence.disputeRateBps / 100).toFixed(1)}% > ${this.mandate.maxDisputeRateBps / 100}%`)
        }
        if (score.evidence.uniqueCounterparties < this.mandate.minCounterparties) {
          reasons.push(`only ${score.evidence.uniqueCounterparties} counterparties`)
        }
        assessed.push({ name: a.name, score, settlement: score.settlement, eligible: !reasons.length, reasons })
      } catch {
        this.push('    payment failed', 'bad')
      }
    }

    this.push('▸ applying mandate', 'head')
    for (const a of assessed) {
      if (a.eligible) this.push(`    ✓ ELIGIBLE  ${a.name}  score ${a.score.score}`, 'ok')
      else this.push(`    ✗ REFUSE    ${a.name}  ${a.reasons.join('; ')}`, 'bad')
    }

    const passed = assessed.filter((a) => a.eligible).sort((x, y) => y.score.score - x.score.score)
    if (!passed.length) this.push('▸ no candidate met the mandate. hiring nobody.', 'bad')
    else {
      this.push(`▸ HIRED ${passed[0]!.name} — score ${passed[0]!.score.score}`, 'ok')
      this.push(`  spent $${spent.toFixed(4)} across ${assessed.length} lookups, decided autonomously`, 'dim')
    }
    this.running.set(false)
  }
}
