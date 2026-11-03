<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '@/lib/api';
import { clearKey, generateKey, loadKey, registerKey, type StoredKey } from '@/lib/keys';
import { ts } from '@/lib/fmt';

const current = ref<StoredKey | null>(null);
const registered = ref<Array<{ keyId: string; fp: string; createdAt: number; revokedAt: number | null }>>([]);
const busy = ref(false);

async function refresh() {
  current.value = await loadKey();
  const res = await api.get<{ items: typeof registered.value }>('/api/v1/keys');
  registered.value = res.items;
}

async function generate() {
  busy.value = true;
  try {
    current.value = await generateKey();
    await registerKey(current.value);
    ElMessage.success('已生成并登记公钥');
    await refresh();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '生成失败');
  } finally {
    busy.value = false;
  }
}

async function revoke(keyId: string) {
  await api.del(`/api/v1/keys/${keyId}`);
  await refresh();
}

async function reset() {
  await clearKey();
  current.value = null;
  ElMessage.warning('本地密钥已删除（历史结果将无法解密）');
}

onMounted(refresh);
</script>

<template>
  <div class="el-scope space-y-3">
    <section class="stc-card p-4">
      <h2 class="mb-2 text-sm font-semibold">本机操作员密钥（P-256）</h2>
      <div v-if="current" class="space-y-1 text-[13px]">
        <div>key_id: <span class="stc-mono">{{ current.keyId }}</span></div>
        <div>指纹: <span class="stc-mono">{{ current.fp }}</span></div>
        <div style="color: var(--color-muted-foreground)">保存在浏览器 IndexedDB（不可导出），清站点数据即丢失。</div>
      </div>
      <p v-else class="text-[13px]" style="color: var(--color-muted-foreground)">
        还没有密钥。生成后公钥会登记到服务端，载荷里会内嵌这把公钥。
      </p>

      <div class="mt-3 flex gap-2">
        <button class="stc-btn" data-variant="primary" :disabled="busy" @click="generate">
          {{ current ? '重新生成' : '生成并登记' }}
        </button>
        <button class="stc-btn" data-variant="danger" :disabled="!current" @click="reset">删除本地密钥</button>
      </div>
      <p class="mt-2 text-[11px]" style="color: var(--color-muted-foreground)">
        注意：重新生成后，旧密钥加密的历史结果将无法解密（服务端只有密文）。
      </p>
    </section>

    <el-table :data="registered" size="small">
      <el-table-column label="key_id" min-width="200">
        <template #default="{ row }"><span class="stc-mono">{{ row.keyId }}</span></template>
      </el-table-column>
      <el-table-column label="指纹" width="180">
        <template #default="{ row }"><span class="stc-mono">{{ row.fp }}</span></template>
      </el-table-column>
      <el-table-column label="登记时间" width="180">
        <template #default="{ row }">{{ ts(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <span class="stc-badge" :data-tone="row.revokedAt ? 'danger' : 'ok'">{{ row.revokedAt ? 'revoked' : 'active' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="120" align="right">
        <template #default="{ row }">
          <button class="stc-btn" :disabled="Boolean(row.revokedAt)" @click="revoke(row.keyId)">吊销</button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>
