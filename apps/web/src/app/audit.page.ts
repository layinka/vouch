import { Component, inject, ChangeDetectionStrategy } from '@angular/core'
import { VouchApi } from './api'

/** The HCS audit trail, read straight from Hedera's public mirror node. */
@Component({
  selector: 'vouch-audit',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    h1 { font-size: 28px; margin: 0 0 6px; }
    .sub { color: var(--dim); margin: 0 0 26px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; font-size: 11px; letter-spacing: 1px; text-transform: uppercase;
         color: var(--dim); padding-bottom: 10px; border-bottom: 1px solid var(--line); }
    td { padding: 11px 12px 11px 0; border-bottom: 1px solid var(--line); font-family: var(--mono); }
    tr:last-child td { border-bottom: none; }
    .seq { color: var(--dim); width: 56px; }
  `,
  template: `
    <div class="wrap">
      <h1>Audit trail</h1>
      <p class="sub">
        Every paid lookup, consensus-timestamped on Hedera.
        @if (api.audit.value()?.topic) {
          <a [href]="api.audit.value()!.topic!" target="_blank" rel="noreferrer">view topic on HashScan ↗</a>
        }
      </p>
      <div class="panel">
        <table>
          <thead>
            <tr><th class="seq">Seq</th><th>Agent</th><th>Score</th><th>Payer</th></tr>
          </thead>
          <tbody>
            @for (e of api.audit.value()?.entries ?? []; track e.seq) {
              <tr>
                <td class="seq">{{ e.seq }}</td>
                <td>{{ $any(e.rec).agent }}</td>
                <td>{{ $any(e.rec).score }}</td>
                <td>{{ $any(e.rec).payer }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
})
export class AuditPage {
  readonly api = inject(VouchApi)
}
