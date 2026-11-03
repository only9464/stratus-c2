<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '@/lib/api';
import { bytes, ts } from '@/lib/fmt';

interface Payload {
  id: string;
  name: string;
  pskId: string;
  os: string | null;
  arch: string | null;
  size: number | null;
  createdAt: number;
  revokedAt: number | null;
}

const rows = ref<Payload[]>([]);
const name = ref(`payload-${new Date().toISOString().slice(0, 10)}`);
const os = ref('windows');
const arch = ref('amd64');
const created = ref<{ id: string; psk: string; psk_id: string; config: Record<string, unknown> } | null>(null);
const link = ref('');
const busy = ref(false);

async function load() {
  const res = await api.get<{ items: Payload[] }>('/api/v1/payloads');
  rows.value = res.items;
}

async function create() {
  busy.value = true;
  try {
    created.value = await api.post('/api/v1/payloads', { name: name.value, os: os.value, arch: arch.value });
    ElMessage.success('已创建：PSK 只显示这一次，请立刻保存');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '创建失败（先登记操作员公钥）');
  } finally {
    busy.value = false;
  }
}

async function upload(pRaw: unknown, file: File) {
  const p = pRaw as Payload;
  busy.value = true;
  try {
    const res = await api.raw(`/api/v1/payloads/${p.id}/binary?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: file,
      headers: { 'content-type': 'application/octet-stream' },
    });
    if (!res.ok) throw new Error(await res.text());
    ElMessage.success('二进制已上传到 R2');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '上传失败');
  } finally {
    busy.value = false;
  }
}

async function makeLink(pRaw: unknown) {
  const p = pRaw as Payload;
  const res = await api.post<{ url: string }>(`/api/v1/payloads/${p.id}/link`);
  link.value = res.url;
  await navigator.clipboard.writeText(res.url).catch(() => undefined);
  ElMessage.success('一次性下载链接已生成（10 分钟有效）并复制');
}

async function revoke(pRaw: unknown) {
  const p = pRaw as Payload;
  await api.del(`/api/v1/payloads/${p.id}`);
  await load();
}

onMounted(load);
</script>

<template>
  <div class="el-scope space-y-3">
    <section class="stc-card p-4">
      <h2 class="mb-3 text-sm font-semibold">新建载荷配置</h2>
      <div class="flex flex-wrap items-end gap-2">
        <label class="text-[12px]">
          <div style="color: var(--color-muted-foreground)">名称</div>
          <input v-model="name" class="stc-input" style="width: 220px" />
        </label>
        <label class="text-[12px]">
          <div style="color: var(--color-muted-foreground)">OS</div>
          <select v-model="os" class="stc-input" style="width: 120px">
            <option>windows</option><option>linux</option><option>darwin</option>
          </select>
        </label>
        <label class="text-[12px]">
          <div style="color: var(--color-muted-foreground)">ARCH</div>
          <select v-model="arch" class="stc-input" style="width: 120px">
            <option>amd64</option><option>arm64</option><option>386</option>
          </select>
        </label>
        <button class="stc-btn" data-variant="primary" :disabled="busy" @click="create">创建</button>
      </div>
      <p class="mt-2 text-[11px]" style="color: var(--color-muted-foreground)">
        服务端没有编译器：这里只生成 PSK + 公钥配置，二进制由你本地编译后上传。
      </p>

      <div v-if="created" class="mt-3 rounded-md border p-3" style="border-color: var(--color-border)">
        <div class="mb-1 text-[12px] font-medium">配置（仅显示一次）</div>
        <pre class="stc-mono max-h-56 overflow-auto whitespace-pre-wrap break-all">{{ JSON.stringify(created.config, null, 2) }}</pre>
      </div>
    </section>

    <el-table :data="rows" size="small">
      <el-table-column label="名称" prop="name" min-width="160" />
      <el-table-column label="PSK ID" min-width="120">
        <template #default="{ row }"><span class="stc-mono">{{ row.pskId }}</span></template>
      </el-table-column>
      <el-table-column label="平台" width="140">
        <template #default="{ row }">{{ row.os || '—' }}/{{ row.arch || '—' }}</template>
      </el-table-column>
      <el-table-column label="大小" width="100">
        <template #default="{ row }">{{ bytes(row.size) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <span class="stc-badge" :data-tone="row.revokedAt ? 'danger' : 'ok'">{{ row.revokedAt ? 'revoked' : 'active' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="创建" width="170">
        <template #default="{ row }">{{ ts(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="280" align="right">
        <template #default="{ row }">
          <label class="stc-btn mr-1 cursor-pointer">
            上传
            <input type="file" class="hidden" @change="(e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) upload(row, f); }" />
          </label>
          <button class="stc-btn mr-1" @click="makeLink(row)">链接</button>
          <button class="stc-btn" data-variant="danger" @click="revoke(row)">吊销</button>
        </template>
      </el-table-column>
    </el-table>

    <div v-if="link" class="stc-card p-3 text-[12px]">
      一次性链接：<span class="stc-mono break-all">{{ link }}</span>
    </div>
  </div>
</template>
