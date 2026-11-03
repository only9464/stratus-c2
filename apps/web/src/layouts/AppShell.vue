<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import { api } from '@/lib/api';
import { loadKey } from '@/lib/keys';

const route = useRoute();
const router = useRouter();
const operator = ref<{ email: string; role: string } | null>(null);
const keyFp = ref<string | null>(null);
const dark = ref(document.documentElement.classList.contains('dark'));

const nav = [
  { to: '/', label: '概览', icon: '◉' },
  { to: '/sessions', label: '会话', icon: '▤' },
  { to: '/tasks', label: '任务', icon: '⇄' },
  { to: '/payloads', label: '载荷', icon: '↓' },
  { to: '/keys', label: '密钥', icon: '⚿' },
  { to: '/audit', label: '审计', icon: '✎' },
  { to: '/quota', label: '配额', icon: '▦' },
  { to: '/settings', label: '设置', icon: '⚙' },
];

const active = computed(() => (route.path === '/' ? '/' : `/${route.path.split('/')[1] ?? ''}`));

function toggleTheme() {
  dark.value = !dark.value;
  document.documentElement.classList.toggle('dark', dark.value);
  document.documentElement.classList.toggle('light', !dark.value);
  localStorage.setItem('stc2.theme', dark.value ? 'dark' : 'light');
}

function logout() {
  api.setToken(null);
  void router.push('/login');
}

onMounted(async () => {
  try {
    operator.value = await api.get('/api/v1/me');
  } catch {
    /* Access 模式下也可能失败，导航守卫会处理 */
  }
  const k = await loadKey();
  keyFp.value = k?.fp ?? null;
});
</script>

<template>
  <div class="flex h-full">
    <aside class="flex w-52 shrink-0 flex-col border-r" style="border-color: var(--color-border)">
      <div class="flex items-center gap-2 px-4 py-4">
        <span class="grid h-7 w-7 place-items-center rounded-md text-xs font-bold"
              style="background: var(--color-primary); color: var(--color-primary-foreground)">S</span>
        <div class="leading-tight">
          <div class="text-sm font-semibold">Stratus</div>
          <div class="text-[11px]" style="color: var(--color-muted-foreground)">edge C2 console</div>
        </div>
      </div>

      <nav class="flex-1 space-y-0.5 px-2">
        <RouterLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors"
          :style="active === item.to
            ? 'background: var(--color-muted); color: var(--color-foreground)'
            : 'color: var(--color-muted-foreground)'"
        >
          <span class="w-4 text-center text-xs opacity-70">{{ item.icon }}</span>
          {{ item.label }}
        </RouterLink>
      </nav>

      <div class="border-t px-3 py-3 text-[11px]" style="border-color: var(--color-border); color: var(--color-muted-foreground)">
        <div class="flex items-center justify-between">
          <span>密钥</span>
          <span class="stc-mono">{{ keyFp ?? '未生成' }}</span>
        </div>
        <div class="mt-1 flex items-center justify-between">
          <span>身份</span>
          <span class="truncate" style="max-width: 100px">{{ operator?.email ?? '—' }}</span>
        </div>
      </div>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col">
      <header class="flex h-12 items-center justify-between border-b px-4" style="border-color: var(--color-border)">
        <div class="text-[13px]" style="color: var(--color-muted-foreground)">
          {{ nav.find((n) => n.to === active)?.label ?? '' }}
        </div>
        <div class="flex items-center gap-2">
          <button class="stc-btn" @click="toggleTheme">{{ dark ? '☾' : '☀' }}</button>
          <span class="stc-badge">{{ operator?.role ?? 'guest' }}</span>
          <button class="stc-btn" @click="logout">退出</button>
        </div>
      </header>

      <main class="min-h-0 flex-1 overflow-auto p-4">
        <RouterView />
      </main>
    </div>
  </div>
</template>
