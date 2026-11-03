<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, HttpError } from '@/lib/api';

const router = useRouter();
const route = useRoute();
const token = ref('');
const busy = ref(false);
const error = ref('');

async function submit() {
  busy.value = true;
  error.value = '';
  api.setToken(token.value.trim() || null);
  try {
    await api.get('/api/v1/me');
    const next = (route.query['next'] as string | undefined) ?? '/';
    await router.push(next);
  } catch (e) {
    api.setToken(null);
    error.value = e instanceof HttpError ? `${e.body.code}: ${e.body.message}` : '无法连接控制台';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="grid h-full place-items-center px-4">
    <div class="w-full max-w-sm">
      <div class="mb-6 text-center">
        <div class="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-lg text-sm font-bold"
             style="background: var(--color-primary); color: var(--color-primary-foreground)">S</div>
        <h1 class="text-lg font-semibold">Stratus Console</h1>
        <p class="mt-1 text-[12px]" style="color: var(--color-muted-foreground)">
          纯 Cloudflare 免费额度的 C2 控制台
        </p>
      </div>

      <form class="stc-card space-y-3 p-4" @submit.prevent="submit">
        <label class="block text-[12px]" style="color: var(--color-muted-foreground)">
          管理员令牌（AUTH_MODE=token）
        </label>
        <input v-model="token" type="password" class="stc-input" placeholder="ADMIN_TOKEN" autocomplete="off" />
        <p class="text-[11px]" style="color: var(--color-muted-foreground)">
          使用 Cloudflare Access 时（AUTH_MODE=access）无需令牌，直接点登录。
        </p>
        <div v-if="error" class="rounded-md px-2 py-1 text-[12px]"
             style="background: color-mix(in oklch, var(--color-danger) 15%, transparent); color: var(--color-danger)">
          {{ error }}
        </div>
        <button class="stc-btn w-full justify-center" data-variant="primary" :disabled="busy" type="submit">
          {{ busy ? '验证中…' : '登录' }}
        </button>
      </form>
    </div>
  </div>
</template>
