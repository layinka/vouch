import { Component, input, ChangeDetectionStrategy } from '@angular/core'
import type { PermissionRow } from './api'

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
  `,
})
export class PermissionMatrix {
  readonly rows = input.required<PermissionRow[]>()
}
