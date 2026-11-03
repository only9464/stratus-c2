<script setup lang="ts">
import { ref } from 'vue';
import { api } from '@/lib/api';

const dark = ref(document.documentElement.classList.contains('dark'));
const token = ref('');
const saved = ref(false);

function toggle() {
  dark.value = !dark.value;
  document.documentElement.classList.toggle('dark', dark.value);
  document.documentElement.classList.toggle('light', !dark.value);
  localStorage.setItem('stc2.theme', dark.value ? 'dark' : 'light');
}

function saveToken() {
  api.setToken(token.value.trim() || null);
  saved.value = true;
  setTimeout(() => (saved.value = false), 1500);
}
</script>

<template>
  <div class="space-y-3">
    <section class="stc-card p-4">
      <h2 class="mb-3 text-sm font-semibold">外观</h2>
      <div class="flex items-center justify-between">
        <div class="text-[13px]">暗色主题</div>
        <button class="stc-btn" @click="toggle">{{ dark ? '已开启' : '已关闭' }}</button>
      </div>
    </section>

    <section class="stc-card p-4">
      <h2 class="mb-3 text-sm font-semibold">访问令牌</h2>
      <p class="mb-2 text-[12px]" style="color: var(--color-muted-foreground)">
        `AUTH_MODE=token` 时用 `wrangler secret put ADMIN_TOKEN` 设置，令牌只存在本机 localStorage。
      </p>
      <div class="flex gap-2">
        <input v-model="token" type="password" class="stc-input" placeholder="ADMIN_TOKEN" />
        <button class="stc-btn" data-variant="primary" @click="saveToken">保存</button>
      </div>
      <div v-if="saved" class="mt-2 text-[12px]" style="color: var(--color-ok)">已保存</div>
    </section>

    <section class="stc-card p-4">
      <h2 class="mb-3 text-sm font-semibold">安全边界（必读）</h2>
      <ul class="space-y-1 text-[12px]" style="color: var(--color-muted-foreground)">
        <li>· 服务端（含 Cloudflare）只能看到密文、序号、大小与时序，看不到命令与结果。</li>
        <li>· 操作员私钥保存在浏览器 IndexedDB，删除即不可恢复；历史结果无法再解密。</li>
        <li>· 审计日志不记录命令明文，只记录"谁在何时对哪个会话做了什么"。</li>
        <li>· 免费额度下不要用轮询心跳：100 台 30s 轮询会直接 1027。</li>
      </ul>
    </section>

    <section class="stc-card p-4">
      <h2 class="mb-2 text-sm font-semibold">关于</h2>
      <p class="text-[12px]" style="color: var(--color-muted-foreground)">
        Stratus 0.1.0 · MIT · 仅用于授权红队演练与安全研究。
      </p>
    </section>
  </div>
</template>
