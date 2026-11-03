<script setup lang="ts">
import { computed } from 'vue';
import { cn } from '@/lib/cn';

type Variant = 'default' | 'primary' | 'danger' | 'ghost';

const props = withDefaults(defineProps<{ variant?: Variant; disabled?: boolean; class?: string }>(), {
  variant: 'default',
  disabled: false,
  class: '',
});

const cls = computed(() => cn('stc-btn', props.class));
const variant = computed(() => (props.variant === 'default' ? undefined : props.variant));
</script>

<template>
  <button :class="cls" :data-variant="variant" :disabled="props.disabled">
    <slot />
  </button>
</template>
