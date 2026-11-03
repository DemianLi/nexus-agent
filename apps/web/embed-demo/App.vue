<script setup lang="ts">
import { computed, ref } from 'vue';

import ModelView from './ModelView.vue';
import type { Device } from './scene';

/** `<nexus-chat>` 交給宿主頁的那份 `detail`，形狀見 `src/embed/nexus-chat.d.ts`（測試頁不引用元件的型別）。 */
interface HostToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  respond(result: unknown): void;
  fail(error: string): void;
}

const devices: readonly Device[] = [
  { id: 'A-12', label: 'A-12 冷卻泵', x: -2.5, z: 1, height: 1.6, color: '#38bdf8' },
  { id: 'B-07', label: 'B-07 壓縮機', x: 0.5, z: -1.5, height: 2.4, color: '#a78bfa' },
  { id: 'C-03', label: 'C-03 感測器', x: 2.8, z: 1.8, height: 0.9, color: '#34d399' },
];
const metrics: Readonly<Record<string, { temperature: string; load: string; state: string }>> = {
  'A-12': { temperature: '41.2 °C', load: '68 %', state: '運轉中' },
  'B-07': { temperature: '57.9 °C', load: '91 %', state: '高負載' },
  'C-03': { temperature: '23.4 °C', load: '—', state: '正常' },
};

const selectedId = ref<string | null>(null);
const theme = ref<'light' | 'dark' | 'auto'>('light');
const selected = computed(() => devices.find((device) => device.id === selectedId.value) ?? null);
const context = computed(() => (selected.value === null ? null : { label: selected.value.label }));

function toggle(id: string | null): void {
  selectedId.value = selectedId.value === id ? null : id;
}

const model = ref<{ focus(id: string): boolean } | null>(null);
const deviceArgument = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: `設備編號：${devices.map((device) => device.id).join('、')}`,
    },
  },
  required: ['id'],
} as const;
/** 宣告給模型的宿主頁工具（#2374）：轉到一台設備、選取一台設備。 */
const hostTools = [
  {
    name: 'focus_device',
    description: '把 3D 模型的視角轉到正對指定的設備。',
    parameters: deviceArgument,
  },
  {
    name: 'highlight_device',
    description: '在 3D 模型上選取並高亮指定的設備，右側顯示它的數據。',
    parameters: deviceArgument,
  },
];

function onHostTool(event: Event): void {
  const call = (event as CustomEvent<HostToolCall>).detail;
  const id = call.args.id;
  const device = devices.find((candidate) => candidate.id === id);
  if (device === undefined) {
    call.fail(`沒有設備 ${String(id)}`);
    return;
  }
  if (call.name === 'focus_device') {
    if (model.value?.focus(device.id) === true) call.respond({ focused: device.id });
    else call.fail('3D 模型還沒準備好');
  } else if (call.name === 'highlight_device') {
    selectedId.value = device.id;
    call.respond({ highlighted: device.id, ...metrics[device.id] });
  } else {
    call.fail(`這個頁面不認得 ${call.name}`);
  }
}
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
      <nav class="panel devices" aria-label="設備清單">
        <h2>設備數據</h2>
        <button
          v-for="device in devices"
          :key="device.id"
          type="button"
          :aria-pressed="selectedId === device.id"
          @click="toggle(device.id)"
        >
          {{ device.label }}
          <span class="metric"
            >{{ metrics[device.id]!.temperature }}・{{ metrics[device.id]!.state }}</span
          >
        </button>
      </nav>
      <section class="stage" aria-label="3D 模型">
        <ModelView
          ref="model"
          :devices="devices"
          :selected="selectedId"
          @pick="selectedId = $event"
        />
      </section>
      <aside class="panel side" aria-label="選取與對話">
        <section class="detail" aria-label="選取的設備">
          <h2>{{ selected?.label ?? '尚未選取設備' }}</h2>
          <dl v-if="selected !== null">
            <dt>溫度</dt>
            <dd>{{ metrics[selected.id]!.temperature }}</dd>
            <dt>負載</dt>
            <dd>{{ metrics[selected.id]!.load }}</dd>
            <dt>狀態</dt>
            <dd>{{ metrics[selected.id]!.state }}</dd>
          </dl>
        </section>
        <section class="chat" aria-label="對話框">
          <nexus-chat
            :theme="theme"
            :context.prop="context"
            :hostTools.prop="hostTools"
            @nexus-host-tool="onHostTool"
          />
        </section>
      </aside>
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
h2 {
  margin: 0 0 8px;
  font-size: 15px;
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
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr) 360px;
  gap: 12px;
  padding: 12px;
}
.panel {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.devices button {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  text-align: left;
}
.devices button[aria-pressed='true'] {
  outline: 3px solid #1e3a8a;
}
.metric {
  font-size: 12px;
  opacity: 0.85;
}
.stage {
  min-width: 0;
  min-height: 0;
  border-radius: 8px;
  overflow: hidden;
}
.detail dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 12px;
  margin: 0;
  font-size: 14px;
}
.detail dd {
  margin: 0;
}
.chat {
  flex: 1;
  min-width: 0;
  min-height: 0;
  border: 1px dashed #78716c;
}
@media (max-width: 720px) {
  .body {
    display: flex;
    flex-direction: column;
  }
  .devices {
    flex-direction: row;
    flex-wrap: wrap;
  }
  .devices h2,
  .metric,
  .detail {
    display: none;
  }
  .stage {
    flex: 0 0 180px;
  }
  .side {
    flex: 1;
  }
}
</style>
