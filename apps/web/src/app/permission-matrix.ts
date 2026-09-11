import { Component, input, output, signal, ChangeDetectionStrategy } from '@angular/core'
import { inject } from '@angular/core'
import { VouchApi, type PermissionRow, type AttemptResult } from './api'

/**
 * The single most important component in the project.
 *
 * It shows, per text record, who is allowed to write it. The asymmetry on the
 * `agent:score` row — the agent cannot, the scorer can — is the entire ENS
 * submission rendered as a grid. A judge who reads nothing else should get it
 * from this.
 */
@Component({
  selector: 'vouch-permission-matrix',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host { display: block; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    caption {
      text-align: left; font-size: 12px; letter-spacing: 1.4px;
      color: var(--dim); padding-bottom: 12px; text-transform: uppercase;
    }
    th {
      text-align: left; font-weight: 600; font-size: 11px; letter-spacing: 1px;
      color: var(--dim); text-transform: uppercase;
      padding: 0 12px 10px 0; border-bottom: 1px solid var(--line);
    }
    th.mid, td.mid { text-align: center; width: 92px; }
    td { padding: 12px 12px 12px 0; border-bottom: 1px solid var(--line); }
    tr:last-child td { border-bottom: none; }
    code { font-family: var(--mono); color: var(--fg); }
    .yes { color: var(--ok); font-weight: 700; }
    .no  { color: var(--bad); font-weight: 700; }
    .owner { font-size: 11px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; }
    .owner.agent  { color: var(--dim); }
    .owner.scorer { color: var(--ok); }
    .note {
      margin-top: 16px; padding: 12px 14px; border-radius: 10px;
      background: var(--panel2); border: 1px solid var(--line);
      font-size: 13px; color: var(--dim); line-height: 1.55;
    }
    .note strong { color: var(--fg); }
    .note code { color: var(--bad); font-size: 12px; }

    .prove { margin-top: 14px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    button {
      font: inherit; font-weight: 600; font-size: 13px; cursor: pointer;
      padding: 10px 16px; border-radius: 9px;
      background: transparent; color: var(--bad);
      border: 1px solid var(--bad);
    }
    button:hover:not(:disabled) { background: color-mix(in srgb, var(--bad) 12%, transparent); }
    button:disabled { opacity: .55; cursor: progress; }
    .hint { font-size: 12px; color: var(--dim); }

    .revert {
      margin-top: 14px; border-radius: 10px; overflow: hidden;
      border: 1px solid var(--bad);
      background: color-mix(in srgb, var(--bad) 10%, var(--panel2));
    }
    .revert .head {
      padding: 12px 14px; font-weight: 700; font-size: 14px; color: var(--bad);
      display: flex; align-items: center; gap: 10px;
    }
    .revert .err {
      font-family: var(--mono); font-size: 15px; color: var(--bad);
      padding: 0 14px 12px; word-break: break-all;
    }
    .revert .meta {
      padding: 12px 14px; font-size: 12px; color: var(--dim);
      border-top: 1px solid color-mix(in srgb, var(--bad) 35%, transparent);
      line-height: 1.7;
    }
    .revert .meta code { color: var(--fg); font-size: 11px; }
    .revert a { color: var(--bad); font-weight: 600; }
  `,
  template: `
    <table>
      <caption>Who can write what</caption>
      <thead>
        <tr>
          <th>Record</th>
          <th class="mid">Agent key</th>
          <th class="mid">Scorer key</th>
          <th>Owned by</th>
        </tr>
      </thead>
      <tbody>
        @for (r of rows(); track r.key) {
          <tr>
            <td><code>{{ r.key }}</code></td>
            <td class="mid" [class.yes]="r.canAgentWrite" [class.no]="!r.canAgentWrite">
              {{ r.canAgentWrite ? '✓' : '✗' }}
            </td>
            <td class="mid" [class.yes]="r.writer === 'scorer'" [class.no]="r.writer !== 'scorer'">
              {{ r.writer === 'scorer' ? '✓' : '✗' }}
            </td>
            <td><span class="owner" [class]="r.writer">{{ r.writer }}</span></td>
          </tr>
        }
      </tbody>
    </table>

    <div class="note">
      Enforced by <strong>ENSv2 Enhanced Access Control</strong>, scoped to individual
      text records on this agent's own Permissioned Resolver. Not by our backend.
      When the agent's key calls <strong>setText(agent:score)</strong> the transaction
      reverts with <code>EACUnauthorizedAccountRoles</code>.
    </div>

    <div class="prove">
      <button (click)="attempt()" [disabled]="busy()">
        {{ busy() ? 'broadcasting to Sepolia…' : 'Attempt write as the agent key' }}
      </button>
      <span class="hint">
        Sends a real transaction from the agent's own key. It will be mined, and it will fail.
      </span>
    </div>

    @if (result(); as r) {
      <div class="revert">
        <div class="head">
          <span>✗</span>
          <span>{{ r.reverted ? 'Reverted on-chain' : 'Unexpectedly succeeded' }}</span>
        </div>
        <div class="err">{{ r.error }}</div>
        <div class="meta">
          The agent signed with <code>{{ r.address }}</code> and tried to set
          <code>{{ r.record }}</code> to <code>{{ r.value }}</code>.
          The resolver refused it.<br>
          <a [href]="r.etherscan" target="_blank" rel="noopener">view the failed transaction on Etherscan ↗</a>
        </div>
      </div>
    }
    @if (failed()) { <div class="revert"><div class="meta">{{ failed() }}</div></div> }
  `,
})
export class PermissionMatrix {
  readonly rows = input.required<PermissionRow[]>()
  readonly agentName = input.required<string>()
  /** emitted once a real reverted transaction is on-chain */
  readonly proved = output<AttemptResult>()

  readonly busy = signal(false)
  readonly result = signal<AttemptResult | null>(null)
  readonly failed = signal<string | null>(null)

  private readonly api = inject(VouchApi)

  attempt() {
    this.busy.set(true)
    this.failed.set(null)
    this.result.set(null)
    this.api.attemptWrite(this.agentName(), 'agent').subscribe({
      next: (r) => {
        this.result.set(r)
        this.proved.emit(r)
        this.busy.set(false)
      },
      error: (e) => {
        this.failed.set(
          e?.error?.error === 'key_not_configured'
            ? 'The agent key is not configured on this deployment, so the live attempt is unavailable here. Run it locally to see the revert.'
            : 'Could not broadcast the attempt. Check the API is running.',
        )
        this.busy.set(false)
      },
    })
  }
}
