<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '@/lib/api';
import { short, ts } from '@/lib/fmt';

interface AuditRow {
  id: string;
  ts: number;
  actorType: string;
  actorId: string | null;
  action: string;
  target: string | null;
  meta: string | null;
}

const rows = ref<AuditRow[]>([]);
const total = ref(0);
const page = ref(1);

async function load() {
  const res = await api.get<{ items: AuditRow[]; total: number }>('/api/v1/audit', { page: page.value, page_size: 50 });
  rows.value = res.items;
  total.value = res.total;
}

onMounted(load);
</script>

<template>
  <div class="el-scope space-y-3">
    <div class="flex items-center gap-2">
      <button class="stc-btn" @click="load">刷新</button>
      <span class="text-[12px]" style="color: var(--color-muted-foreground)">
        共 {{ total }} 条 · 审计只记"谁在何时对哪个目标做了什么"，不含命令明文
      </span>
    </div>

    <el-table :data="rows" size="small">
      <el-table-column label="时间" width="180">
        <template #default="{ row }">{{ ts(row.ts) }}</template>
      </el-table-column>
      <el-table-column label="角色" prop="actorType" width="100" />
      <el-table-column label="动作" prop="action" min-width="180" />
      <el-table-column label="目标" min-width="140">
        <template #default="{ row }"><span class="stc-mono">{{ short(row.target, 16) }}</span></template>
      </el-table-column>
      <el-table-column label="元数据" min-width="260">
        <template #default="{ row }">
          <span class="stc-mono" style="color: var(--color-muted-foreground)">{{ short(row.meta, 80) }}</span>
        </template>
      </el-table-column>
    </el-table>

    <div class="flex justify-end">
      <el-pagination :current-page="page" :page-size="50" :total="total" layout="prev, pager, next" @current-change="(p: number) => { page = p; load(); }" />
    </div>
  </div>
</template>
