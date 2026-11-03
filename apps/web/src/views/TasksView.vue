<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '@/lib/api';
import { short, ts } from '@/lib/fmt';

interface Task {
  id: string;
  sessionId: string;
  cat: string;
  status: string;
  size: number | null;
  createdAt: number;
  completedAt: number | null;
}

const rows = ref<Task[]>([]);
const total = ref(0);
const page = ref(1);
const status = ref('');
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    const res = await api.get<{ items: Task[]; total: number }>('/api/v1/tasks', {
      page: page.value,
      page_size: 30,
      status: status.value,
    });
    rows.value = res.items;
    total.value = res.total;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="el-scope space-y-3">
    <div class="flex items-center gap-2">
      <select v-model="status" class="stc-input" style="max-width: 160px" @change="page = 1; load()">
        <option value="">全部状态</option>
        <option v-for="s in ['queued', 'dispatched', 'running', 'done', 'failed', 'expired', 'canceled']" :key="s" :value="s">{{ s }}</option>
      </select>
      <button class="stc-btn" @click="load">刷新</button>
      <span class="text-[12px]" style="color: var(--color-muted-foreground)">共 {{ total }} 条</span>
    </div>

    <el-table v-loading="loading" :data="rows" size="small">
      <el-table-column label="任务" min-width="140">
        <template #default="{ row }"><span class="stc-mono">{{ short(row.id, 12) }}</span></template>
      </el-table-column>
      <el-table-column label="会话" min-width="140">
        <template #default="{ row }">
          <RouterLink :to="`/sessions/${row.sessionId}`" class="stc-mono underline">{{ short(row.sessionId, 12) }}</RouterLink>
        </template>
      </el-table-column>
      <el-table-column label="分类" prop="cat" width="100" />
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <span class="stc-badge" :data-tone="row.status === 'done' ? 'ok' : row.status === 'failed' ? 'danger' : 'warn'">
            {{ row.status }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="密文大小" width="110">
        <template #default="{ row }">{{ row.size ?? '—' }} B</template>
      </el-table-column>
      <el-table-column label="下发时间" width="180">
        <template #default="{ row }">{{ ts(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="完成时间" width="180">
        <template #default="{ row }">{{ ts(row.completedAt) }}</template>
      </el-table-column>
    </el-table>

    <div class="flex justify-end">
      <el-pagination
        :current-page="page"
        :page-size="30"
        :total="total"
        layout="prev, pager, next, total"
        @current-change="(p: number) => { page = p; load(); }"
      />
    </div>
  </div>
</template>
