<script setup lang="ts">
import { computed, ref } from 'vue';

const devices = ['A-12 冷卻泵', 'B-07 壓縮機', 'C-03 感測器'];
const selected = ref<string | null>(null);
const theme = ref<'light' | 'dark' | 'auto'>('light');
const context = computed(() => (selected.value === null ? null : { label: selected.value }));
</script>

<template>
  <div class="host" :data-theme="theme">
    <header class="bar">
      <strong>設備監控（Vue 測試頁）</strong>
      <label>
        主題
        <select v-model="theme" aria-label="主題">
          <option value="light">亮</option>
          <option value="dark">暗</option>
          <option value="auto">跟系統</option>
        </select>
      </label>
    </header>
    <main class="body">
      <nav class="devices" aria-label="設備清單">
        <button
          v-for="device in devices"
          :key="device"
          type="button"
          :aria-pressed="selected === device"
          @click="selected = selected === device ? null : device"
        >
          {{ device }}
        </button>
      </nav>
      <section class="chat" aria-label="對話框">
        <nexus-chat :theme="theme" :context.prop="context" />
      </section>
    </main>
  </div>
</template>

<style>
/* 宿主頁自己的樣式，故意寫得很重：元件在 Shadow DOM 裡，這些都不該影響它。 */
* {
  box-sizing: border-box;
}
html,
body {
  margin: 0;
  height: 100%;
  font-family: Georgia, serif;
}
button {
  font: inherit;
  color: #fff;
  background: #c2410c;
  border: 0;
  border-radius: 0;
  padding: 8px 12px;
}
p {
  margin: 0;
  color: #c2410c;
}
#app,
.host {
  height: 100%;
}
.host {
  display: flex;
  flex-direction: column;
  background: #f5f5f4;
}
.host[data-theme='dark'] {
  background: #1c1917;
  color: #e7e5e4;
}
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: #1e3a8a;
  color: #fff;
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 16px;
  padding: 16px;
}
.devices {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 160px;
}
.devices button[aria-pressed='true'] {
  outline: 3px solid #1e3a8a;
}
.chat {
  flex: 1;
  min-width: 0;
  min-height: 0;
  border: 1px dashed #78716c;
}
@media (max-width: 640px) {
  .body {
    flex-direction: column;
  }
  .devices {
    flex-direction: row;
    width: auto;
  }
}
</style>
