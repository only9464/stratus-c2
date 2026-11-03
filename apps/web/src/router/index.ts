import { createRouter, createWebHistory } from 'vue-router';
import { api } from '@/lib/api';

const routes = [
  { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { public: true } },
  {
    path: '/',
    component: () => import('@/layouts/AppShell.vue'),
    children: [
      { path: '', name: 'dashboard', component: () => import('@/views/DashboardView.vue') },
      { path: 'sessions', name: 'sessions', component: () => import('@/views/SessionsView.vue') },
      { path: 'sessions/:id', name: 'session', component: () => import('@/views/SessionDetailView.vue') },
      { path: 'tasks', name: 'tasks', component: () => import('@/views/TasksView.vue') },
      { path: 'payloads', name: 'payloads', component: () => import('@/views/PayloadsView.vue') },
      { path: 'keys', name: 'keys', component: () => import('@/views/KeysView.vue') },
      { path: 'audit', name: 'audit', component: () => import('@/views/AuditView.vue') },
      { path: 'quota', name: 'quota', component: () => import('@/views/QuotaView.vue') },
      { path: 'settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  if (to.meta['public']) return true;
  if (!api.hasToken()) {
    // AUTH_MODE=access 时由 Cloudflare Access 前置，token 为空也能通过 /me 探索
    const ok = await api.probe();
    if (!ok) return { name: 'login', query: { next: to.fullPath } };
    return true;
  }
  return true;
});
