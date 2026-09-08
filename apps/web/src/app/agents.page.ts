import { Component, inject, ChangeDetectionStrategy } from '@angular/core'
import { RouterLink } from '@angular/router'
import { VouchApi } from './api'

/**
 * The directory. Note what is NOT here: scores.
 *
 * The API deliberately withholds them from the free listing — you can see who
 * exists and how much work they claim to have done, but what they are worth
 * costs a tenth of a cent. That withholding is the business model, so the page
 * should make it obvious rather than apologise for it.
 */
@Component({
  selector: 'vouch-agents',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    h1 { font-size: 28px; margin: 0 0 6px; }
    .sub { color: var(--dim); margin: 0 0 28px; }
    .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
    .card { display: block; color: inherit; }
    .card:hover { text-decoration: none; border-color: var(--ok); }
    .name { font-family: var(--mono); font-size: 16px; margin-bottom: 10px; word-break: break-all; }
    .row { display: flex; justify-content: space-between; align-items: center;
           font-size: 13px; color: var(--dim); margin-top: 8px; }
    .locked { font-family: var(--mono); color: var(--dim); letter-spacing: 2px; }
    .uaid { font-family: var(--mono); font-size: 11px; color: var(--dim);
            margin-top: 12px; word-break: break-all; opacity: .75; }
    .skeleton { height: 132px; border-radius: 14px; background: var(--panel);
                border: 1px solid var(--line); }
    .err { color: var(--bad); }
  `,
  template: `
    <div class="wrap">
      <h1>Agent directory</h1>
      <p class="sub">
        Free to browse. Scores are withheld — evidence costs $0.001 per lookup.
      </p>

      @if (api.agents.isLoading()) {
        <div class="grid">
          @for (i of [1,2,3,4]; track i) { <div class="skeleton"></div> }
        </div>
      } @else if (api.agents.error()) {
        <div class="panel err">
          Cannot reach the API. Is it running on {{ base }}?
        </div>
      } @else {
        <div class="grid">
          @for (a of api.agents.value()?.agents ?? []; track a.erc8004Id) {
            <a class="panel card" [routerLink]="['/agents', a.name]">
              <div class="name">{{ a.name }}</div>
              <div class="row">
                <span>ERC-8004 #{{ a.erc8004Id }}</span>
                <span class="pill" [class]="a.verdict">{{ a.verdict }}</span>
              </div>
              <div class="row">
                <span>{{ a.totalJobs }} jobs attested</span>
                <span class="locked">score ●●●</span>
              </div>
              @if (a.uaid) {
                <div class="uaid">{{ a.uaid.slice(0, 46) }}…</div>
              }
            </a>
          }
        </div>
      }
    </div>
  `,
})
export class AgentsPage {
  readonly api = inject(VouchApi)
  readonly base = (globalThis as { __VOUCH_API__?: string }).__VOUCH_API__ ?? 'http://localhost:3000'
}
