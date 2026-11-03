<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '@/lib/api';
import { ago, pct } from '@/lib/fmt';

interface Stats {
  sessions: { total: number; online: number };
  tasks: { total: number; done: number; success_rate: number };
  by_cat: Array<{ cat: string; n: number }>;
}
interface Verdict {
  key: string;
  used: number;
  limit: number;
  ratio: number;
  level: 'ok' | 'warn' | 'crit';
}

const stats = ref<Stats | null>(null);
const verdicts = ref<Verdict[]>([]);
const recent = ref<Array<{ id: string; host: string; status: string; lastSeen: number; username: string }>>([]);
const loading = ref(true);

onMounted(async () => {
  try {
    const [s, q, list] = await Promise.all([
      api.get<Stats>('/api/v1/stats'),
      api.get<{ verdicts: Verdict[] }>('/api/v1/quota'),
      api.get<{ items: typeof recent.value }>('/api/v1/sessions', { page_size: 6, sort: 'last_seen' }),
    ]);
    stats.value = s;
    verdicts.value = q.verdicts;
    recent.value = list.items;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="space-y-4">
    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div class="stc-card p-4">
        <div class="text-[12px]" style="color: var(--color-muted-foreground)">在线会话</div>
        <div class="mt-1 text-2xl font-semibold">{{ stats?.sessions.online ?? '—' }}</div>
        <div class="text-[11px]" style="color: var(--color-muted-foreground)">
          累计 {{ stats?.sessions.total ?? 0 }}
        </div>
      </div>
      <div class="stc-card p-4">
        <div class="text-[12px]" style="color: var(--color-muted-foreground)">任务总数</div>
        <div class="mt-1 text-2xl font-semibold">{{ stats?.tasks.total ?? '—' }}</div>
        <div class="text-[11px]" style="color: var(--color-muted-foreground)">完成 {{ stats?.tasks.done ?? 0 }}</div>
      </div>
      <div class="stc-card p-4">
        <div class="text-[12px]" style="color: var(--color-muted-foreground)">成功率</div>
        <div class="mt-1 text-2xl font-semibold">{{ pct(stats?.tasks.success_rate ?? 0) }}</div>
        <div class="text-[11px]" style="color: var(--color-muted-foreground)">done / total</div>
      </div>
      <div class="stc-card p-4">
        <div class="text-[12px]" style="color: var(--color-muted-foreground)">通道</div>
        <div class="mt-1 text-sm font-semibold">WS 优先 · HTTP 兜底</div>
        <div class="text-[11px]" style="color: var(--color-muted-foreground)">DO hibernation 已启用</div>
      </div>
    </div>

    <div class="grid gap-3 lg:grid-cols-2">
      <section class="stc-card p-4">
        <h2 class="mb-3 text-sm font-semibold">最近会话</h2>
        <div v-if="loading" class="text-[12px]" style="color: var(--color-muted-foreground)">加载中…</div>
        <ul v-else class="space-y-2">
          <li v-for="s in recent" :key="s.id" class="flex items-center justify-between text-[13px]">
            <RouterLink :to="`/sessions/${s.id}`" class="truncate hover:underline">
              {{ s.host || s.id }} <span style="color: var(--color-muted-foreground)">/ {{ s.username || '—' }}</span>
            </RouterLink>
            <span class="flex items-center gap-2">
              <span class="stc-badge" :data-tone="s.status === 'online' ? 'ok' : 'warn'">{{ s.status }}</span>
              <span class="text-[11px]" style="color: var(--color-muted-foreground)">{{ ago(s.lastSeen) }}</span>
            </span>
          </li>
          <li v-if="!recent.length" class="text-[12px]" style="color: var(--color-muted-foreground)">
            还没有会话。生成载荷并在目标上运行参考植入体即可上线。
          </li>
        </ul>
      </section>

      <section class="stc-card p-4">
        <h2 class="mb-3 text-sm font-semibold">免费额度水位（按 100 会话/日粗算）</h2>
        <div class="space-y-2">
          <div v-for="v in verdicts.slice(0, 6)" :key="v.key">
            <div class="mb-1 flex items-center justify-between text-[11px]">
              <span class="stc-mono">{{ v.key }}</span>
              <span :style="`color: var(--color-${v.level === 'crit' ? 'danger' : v.level === 'warn' ? 'warn' : 'muted-foreground'})`">
                {{ pct(v.ratio) }}
              </span>
            </div>
            <div class="h-1.5 overflow-hidden rounded-full" style="background: var(--color-muted)">
              <div class="h-full rounded-full transition-all"
                   :style="`width:${Math.min(100, v.ratio * 100)}%; background: var(--color-${v.level === 'crit' ? 'danger' : v.level === 'warn' ? 'warn' : 'primary'})`" />
            </div>
          </div>
        </div>
        <p class="mt-3 text-[11px]" style="color: var(--color-muted-foreground)">
          详细口径见 docs/01-research/01-cloudflare-platform-limits.md §11
        </p>
      </section>
    </div>
  </div>
</template>
