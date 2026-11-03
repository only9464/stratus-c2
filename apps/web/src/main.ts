import { createApp } from 'vue';
import { createPinia } from 'pinia';

// Element Plus 按需引入（unplugin-vue-components），只保留暗色变量这一份全局样式。
// 样式加载顺序：EP 的按需样式 → 我们的 token 覆盖层（详见 docs/05-frontend/01-design-system.md §3）
import 'element-plus/theme-chalk/dark/css-vars.css';
import './styles/theme.css';

import App from './App.vue';
import { router } from './router';

createApp(App).use(createPinia()).use(router).mount('#app');
