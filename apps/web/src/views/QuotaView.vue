<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '@/lib/api';
import { pct } from '@/lib/fmt';

interface Verdict {
  key: string;
  used: number;
  limit: number;
  ratio: number;
  level: 'ok' | 'warn' | 'crit';
}
interface QuotaResp {
  free_tier: Record<string, Record<string, number>>;
  reference_budget: Record<string, number>;
  verdicts: Verdict[];
  daily: Array<{ day: string; d1RowsWrite: number | null }>;
}

const data = ref<QuotaResp | null>(null);

const labels: Record<string, string> = {
  workersRequests: 'Workers 请求/天',
  doRequests: 'DO 请求/天',
  doGbSeconds: 'DO duration (GB-s)/天',
  d1RowsRead: 'D1 行读/天',
  d1RowsWrite: 'D1 行写/天',
  kvWrites: 'KV 写/天',
  r2ClassA: 'R2 Class A/天',
  r2ClassB: 'R2 Class B/天',
  r2GbMonth: 'R2 存储 (GB-month)',
};

onMounted(async () => {
  data.value = await api.get<QuotaResp>('/api/v1/quota');
});
</script>

<template>
  <div v-if="data" class="space-y-3">
    <section class="stc-card p-4">
      <h2 class="mb-1 text-sm font-semibold">免费额度水位</h2>
      <p class="mb-3 text-[12px]" style="color: var(--color-muted-foreground)">
        口径：100 会话 / 24 小时 / 60s 心跳 / 人均 3 条命令/小时 / 每天 5 次 10MB 回传。
        与 docs/01-research/01-cloudflare-platform-limits.md §11 一致。
      </p>
      <div class="space-y-2">
        <div v-for="v in data.verdicts" :key="v.key">
          <div class="mb-1 flex items-center justify-between text-[12px]">
            <span>{{ labels[v.key] ?? v.key }}</span>
            <span class="stc-mono" :style="`color: var(--color-${v.level === 'crit' ? 'danger' : v.level === 'warn' ? 'warn' : 'muted-foreground'})`">
              {{ v.used }} / {{ v.limit }} · {{ pct(v.ratio) }}
            </span>
          </div>
          <div class="h-2 overflow-hidden rounded-full" style="background: var(--color-muted)">
            <div class="h-full rounded-full"
                 :style="`width:${Math.min(100, v.ratio * 100)}%; background: var(--color-${v.level === 'crit' ? 'danger' : v.level === 'warn' ? 'warn' : 'primary'})`" />
          </div>
        </div>
      </div>
      <p class="mt-3 text-[12px]" style="color: var(--color-warn)">
        结论：唯一会先撞线的是 <b>R2 存储（10 GB-month）</b>。请给文件/结果设置 TTL，或把大文件改走分片直传。
      </p>
    </section>

    <section class="stc-card p-4">
      <h2 class="mb-2 text-sm font-semibold">已记录的日用量（Cron 每日汇总）</h2>
      <table class="w-full text-[12px]">
        <thead>
          <tr style="color: var(--color-muted-foreground)">
            <th class="text-left font-normal">日期</th>
            <th class="text-right font-normal">D1 行写</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in data.daily" :key="d.day">
            <td>{{ d.day }}</td>
            <td class="text-right">{{ d.d1RowsWrite ?? 0 }}</td>
          </tr>
          <tr v-if="!data.daily.length">
            <td colspan="2" style="color: var(--color-muted-foreground)">还没有数据（等第一次 Cron 汇总）</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
  <div v-else class="stc-card p-6 text-[13px]">加载中…</div>
</template>
