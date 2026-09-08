import { Component, ChangeDetectionStrategy } from '@angular/core'
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router'

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    header { border-bottom: 1px solid var(--line); margin-bottom: 32px; }
    .bar { max-width: 1120px; margin: 0 auto; padding: 18px 24px;
           display: flex; align-items: center; gap: 28px; }
    .brand { display: flex; align-items: center; gap: 12px; font-weight: 700; font-size: 19px; }
    svg { display: block; }
    nav { display: flex; gap: 22px; margin-left: auto; }
    nav a { color: var(--dim); font-size: 14px; font-weight: 500; }
    nav a:hover { color: var(--fg); text-decoration: none; }
    nav a.active { color: var(--ok); }
  `,
  template: `
    <header>
      <div class="bar">
        <a class="brand" routerLink="/">
          <svg width="30" height="30" viewBox="0 0 512 512" aria-hidden="true">
            <rect width="512" height="512" rx="116" fill="#0b1524" stroke="#243350" stroke-width="10"/>
            <g stroke-linejoin="miter" fill="none" stroke-width="64">
              <clipPath id="l"><rect width="256" height="512"/></clipPath>
              <clipPath id="r"><rect x="256" width="256" height="512"/></clipPath>
              <g clip-path="url(#l)"><polyline points="128,146 256,376 384,146" stroke="#4FE39C"/></g>
              <g clip-path="url(#r)"><polyline points="128,146 256,376 384,146" stroke="#5A6E8C"/></g>
            </g>
          </svg>
          Vouch
        </a>
        <nav>
          <a routerLink="/agents" routerLinkActive="active">Agents</a>
          <a routerLink="/demo" routerLinkActive="active">Live demo</a>
          <a routerLink="/audit" routerLinkActive="active">Audit</a>
        </nav>
      </div>
    </header>
    <router-outlet />
  `,
})
export class App {}
