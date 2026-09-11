import { Component, inject, input, signal, ChangeDetectionStrategy } from '@angular/core'
import { VouchApi, type ScoreDetail } from './api'
import { PermissionMatrix } from './permission-matrix'

/**
 * An agent's passport: identity, the permission matrix, and — once you pay —
 * the evidence behind its score.
 *
 * The score is not fetched on load. You have to click "buy", a real x402 payment
 * settles on Hedera, and the settlement receipt appears with it. That sequence
 * is the demo: claims are free, evidence costs money.
 */
@Component({
  selector: 'vouch-passport',
  imports: [PermissionMatrix],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    h1 { font-family: var(--mono); font-size: 26px; margin: 0 0 4px; word-break: break-all; }
    .sub { color: var(--dim); margin: 0 0 26px; font-size: 14px; }
    .cols { display: grid; gap: 20px; grid-template-columns: 1.1fr 1fr; align-items: start; }
    @media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
    h2 { font-size: 12px; letter-spacing: 1.4px; text-transform: uppercase;
         color: var(--dim); margin: 0 0 16px; }
    dl { display: grid; grid-template-columns: 116px 1fr; gap: 10px 14px; margin: 0; font-size: 13px; }
    dt { color: var(--dim); }
    dd { margin: 0; font-family: var(--mono); word-break: break-all; }
    .buy { text-align: center; padding: 30px 22px; }
    .price { font-size: 13px; color: var(--dim); margin-bottom: 16px; }
    .score { font-size: 62px; font-weight: 800; line-height: 1; letter-spacing: -2px; }
    .score.trusted { color: var(--ok); }
    .score.caution { color: var(--warn); }
    .score.avoid   { color: var(--bad); }
    .of { font-size: 17px; color: var(--dim); font-weight: 500; }
    .comp { margin-top: 22px; display: grid; gap: 8px; }
    .comp .bar { display: grid; grid-template-columns: 92px 1fr 46px; gap: 10px;
                 align-items: center; font-size: 12px; }
    .comp .track { height: 7px; background: var(--panel2); border-radius: 4px; overflow: hidden; }
    .comp .fill { height: 100%; background: var(--ok); border-radius: 4px; }
    .comp .fill.neg { background: var(--bad); }
    .comp .val { text-align: right; font-family: var(--mono); color: var(--dim); }
    .ev { margin-top: 22px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; font-size: 13px; }
    .ev div { display: flex; justify-content: space-between; }
    .ev span:first-child { color: var(--dim); }
    .receipt { margin-top: 20px; padding: 12px 14px; border-radius: 10px;
               background: rgba(79,227,156,.07); border: 1px solid rgba(79,227,156,.3);
               font-size: 12px; text-align: left; }
    .receipt div { margin: 3px 0; }
    .err { color: var(--bad); font-size: 13px; margin-top: 12px; }
    section + section { margin-top: 20px; }
  `,
  template: `
    <div class="wrap">
      <h1>{{ name() }}</h1>
      <p class="sub">ENSv2 subname · non-transferable · expiring</p>

      <div class="cols">
        <div>
          <section class="panel">
            <vouch-permission-matrix [rows]="perms.value()?.records ?? []" [agentName]="name()" />
          </section>

          <section class="panel">
            <h2>Identity</h2>
            <dl>
              <dt>ERC-8004</dt><dd>#{{ ident.value()?.identity?.erc8004Id }}</dd>
              <dt>Resolver</dt><dd>{{ ident.value()?.identity?.resolver }}</dd>
              <dt>Namehash</dt><dd>{{ ident.value()?.identity?.node }}</dd>
              <dt>HCS-14 UAID</dt><dd>{{ ident.value()?.identity?.uaid }}</dd>
            </dl>
          </section>
        </div>

        <section class="panel buy">
          @if (!score()) {
            <h2>Evidence</h2>
            <p class="price">
              This agent's score is derived from indexed on-chain evidence.<br>
              A lookup costs <strong>$0.001</strong>, settled over x402 on Hedera.
            </p>
            <button class="primary" (click)="buy()" [disabled]="busy()">
              {{ busy() ? 'paying…' : 'Buy reputation lookup — $0.001' }}
            </button>
            @if (error()) { <div class="err">{{ error() }}</div> }
          } @else {
            <h2>Trust score</h2>
            <div class="score" [class]="score()!.verdict">
              {{ score()!.score }}<span class="of"> / 1000</span>
            </div>
            <div style="margin-top:10px">
              <span class="pill" [class]="score()!.verdict">{{ score()!.verdict }}</span>
            </div>

            <div class="comp">
              @for (c of components(); track c.key) {
                <div class="bar">
                  <span class="muted">{{ c.key }}</span>
                  <span class="track">
                    <span class="fill" [class.neg]="c.value < 0"
                          [style.width.%]="c.pct"></span>
                  </span>
                  <span class="val">{{ c.value }}</span>
                </div>
              }
            </div>

            <div class="ev">
              <div><span>jobs</span><span>{{ score()!.evidence.totalJobs }}</span></div>
              <div><span>counterparties</span><span>{{ score()!.evidence.uniqueCounterparties }}</span></div>
              <div><span>disputed</span><span>{{ score()!.evidence.disputedJobs }}</span></div>
              <div><span>failed</span><span>{{ score()!.evidence.failedJobs }}</span></div>
              <div><span>dispute rate</span><span>{{ (score()!.evidence.disputeRateBps / 100).toFixed(1) }}%</span></div>
            </div>

            @if (receipt(); as r) {
              <div class="receipt">
                <div class="muted">settled on Hedera</div>
                <div>payer <span class="mono">{{ r.payer }}</span></div>
                <div><a [href]="r.hashscan" target="_blank" rel="noreferrer">view on HashScan ↗</a></div>
              </div>
            }
          }
        </section>
      </div>
    </div>
  `,
})
export class PassportPage {
  /** bound from the route via withComponentInputBinding */
  readonly name = input.required<string>()

  private readonly api = inject(VouchApi)
  readonly ident = this.api.identity(() => this.name())
  readonly perms = this.api.permissions(() => this.name())

  readonly score = signal<ScoreDetail | null>(null)
  readonly receipt = signal<{ payer: string; hashscan: string } | null>(null)
  readonly busy = signal(false)
  readonly error = signal<string | null>(null)

  components() {
    const c = this.score()?.components ?? {}
    const max = Math.max(1, ...Object.values(c).map((v) => Math.abs(v)))
    return Object.entries(c).map(([key, value]) => ({
      key, value, pct: Math.round((Math.abs(value) / max) * 100),
    }))
  }

  buy() {
    this.busy.set(true)
    this.error.set(null)
    this.api.buyScore(this.name()).subscribe({
      next: (r) => {
        this.score.set(r)
        const s = (r as { settlement?: { payer: string; hashscan: string } }).settlement
        if (s) this.receipt.set(s)
        this.busy.set(false)
      },
      error: (e: { error?: { message?: string } }) => {
        this.error.set(e.error?.message ?? 'payment failed')
        this.busy.set(false)
      },
    })
  }
}
