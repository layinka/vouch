import { Routes } from '@angular/router'

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'agents' },
  { path: 'agents', loadComponent: () => import('./agents.page').then((m) => m.AgentsPage) },
  { path: 'agents/:name', loadComponent: () => import('./passport.page').then((m) => m.PassportPage) },
  { path: 'demo', loadComponent: () => import('./demo.page').then((m) => m.DemoPage) },
  { path: 'audit', loadComponent: () => import('./audit.page').then((m) => m.AuditPage) },
  { path: '**', redirectTo: 'agents' },
]
