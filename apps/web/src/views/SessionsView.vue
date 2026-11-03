<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import { api } from '@/lib/api';
import { ago, short } from '@/lib/fmt';

interface Session {
  id: string;
  host: string | null;
  username: string | null;
  os: string | null;
  arch: string | null;
  internalIp: string | null;
  externalIp: string | null;
  status: string;
  caps: string[];
  lastSeen: number;
  task_stats: Record<string, number>;
}

const router = useRouter();
const rows = ref<Session[]>([]);
const total = ref(0);
const page = ref(1);
const size = ref(20);
const status = ref('');
const q = ref('');
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    const res = await api.get<{ items: Session[]; total: number }>('/api/v1/sessions', {
      page: page.value,
      page_size: size.value,
      status: status.value,
      q: q.value,
    });
    rows.value = res.items;
    total.value = res.total;
  } finally {
    loading.value = false;
  }
}

function open(row: Session) {
  void router.push(`/sessions/${row.id}`);
}

async function kill(rowRaw: unknown) {
  const row = rowRaw as Session;
  await ElMessageBox.confirm(
    `将标记会话 ${row.host ?? row.id} 为 dead 并尽力下发 kill。此操作不可撤销。`,
    '确认',
    { type: 'warning', confirmButtonText: '标记 dead', cancelButtonText: '取消' },
  );
  await api.del(`/api/v1/sessions/${row.id}?confirm=1`);
  await load();
}

onMounted(load);
</script>

<template>
  <div class="el-scope space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <input v-model="q" class="stc-input" style="max-width: 240px" placeholder="搜索 host / user / IP" @keyup.enter="page = 1; load()" />
      <select v-model="status" class="stc-input" style="max-width: 140px" @change="page = 1; load()">
        <option value="">全部状态</option>
        <option value="online">online</option>
        <option value="offline">offline</option>
        <option value="dead">dead</option>
      </select>
      <button class="stc-btn" @click="page = 1; load()">刷新</button>
      <span class="text-[12px]" style="color: var(--color-muted-foreground)">共 {{ total }} 条</span>
    </div>

    <el-table v-loading="loading" :data="rows" size="small" @row-click="open" style="width: 100%">
      <el-table-column label="主机" min-width="160">
        <template #default="{ row }">
          <div class="flex flex-col">
            <span class="font-medium">{{ row.host || '(未上报)' }}</span>
            <span class="stc-mono" style="color: var(--color-muted-foreground)">{{ short(row.id, 12) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="用户" prop="username" width="120" />
      <el-table-column label="系统" width="140">
        <template #default="{ row }">{{ row.os || '—' }} / {{ row.arch || '—' }}</template>
      </el-table-column>
      <el-table-column label="地址" min-width="150">
        <template #default="{ row }">
          <span class="stc-mono">{{ row.internalIp || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="能力" min-width="150">
        <template #default="{ row }">
          <span v-for="c in row.caps.slice(0, 4)" :key="c" class="stc-badge mr-1">{{ c }}</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <span class="stc-badge" :data-tone="row.status === 'online' ? 'ok' : row.status === 'dead' ? 'danger' : 'warn'">
            {{ row.status }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="最后心跳" width="100">
        <template #default="{ row }">{{ ago(row.lastSeen) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="110" align="right">
        <template #default="{ row }">
          <button class="stc-btn" @click.stop="kill(row)">kill</button>
        </template>
      </el-table-column>
    </el-table>

    <div class="flex justify-end">
      <el-pagination
        :current-page="page"
        :page-size="size"
        :total="total"
        layout="prev, pager, next, total"
        @current-change="(p: number) => { page = p; load(); }"
      />
    </div>
  </div>
</template>
