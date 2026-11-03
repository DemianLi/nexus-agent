<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { clampView, draw, pick, topCenter, type Device, type View } from './scene';

const props = defineProps<{ devices: readonly Device[]; selected: string | null }>();
const emit = defineEmits<{ pick: [id: string | null] }>();

const canvas = ref<HTMLCanvasElement | null>(null);
let view: View = { yaw: 0.6, pitch: 0.55, distance: 14 };
let faces: ReturnType<typeof draw> = [];
let drag: { x: number; y: number; moved: boolean } | null = null;

function size(): { width: number; height: number } {
  const element = canvas.value;
  return { width: element?.clientWidth ?? 0, height: element?.clientHeight ?? 0 };
}

function render(): void {
  const element = canvas.value;
  const context = element?.getContext('2d');
  if (element === null || element === undefined || context === null || context === undefined) {
    return;
  }
  const { width, height } = size();
  const ratio = window.devicePixelRatio;
  element.width = Math.round(width * ratio);
  element.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  faces = draw(context, props.devices, view, props.selected, width, height);
}

function update(next: View): void {
  view = clampView(next);
  render();
}

/**
 * 轉到正對著這台設備：它落在畫面水平的正中間、在離相機近的那一側（宿主頁工具 `focus_device`，#2374）。
 *
 * @returns 找不到這個 id 就是 false，視角不動。
 */
function focus(id: string): boolean {
  const device = props.devices.find((candidate) => candidate.id === id);
  if (device === undefined) return false;
  update({ ...view, yaw: Math.atan2(device.x, device.z) + Math.PI });
  return true;
}

defineExpose({ focus });

function local(event: MouseEvent): [number, number] {
  const rect = canvas.value!.getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
}

function onPointerDown(event: PointerEvent): void {
  canvas.value?.setPointerCapture(event.pointerId);
  drag = { x: event.clientX, y: event.clientY, moved: false };
}

function onPointerMove(event: PointerEvent): void {
  if (drag === null) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag = { x: event.clientX, y: event.clientY, moved: true };
  update({ ...view, yaw: view.yaw + dx * 0.01, pitch: view.pitch + dy * 0.01 });
}

function onPointerUp(event: PointerEvent): void {
  const wasDrag = drag?.moved ?? false;
  drag = null;
  if (wasDrag) return;
  emit('pick', pick(faces, local(event))?.id ?? null);
}

function onWheel(event: WheelEvent): void {
  event.preventDefault();
  update({ ...view, distance: view.distance + Math.sign(event.deltaY) });
}

/**
 * 焦點是不是在可輸入的元素上。`<nexus-chat>` 的 shadow root 冒出來的事件，`target` 會被換成元素本身，所以看
 * `composedPath()[0]`（`docs/embed-chat.md`〈宿主頁的快捷鍵與指標操作〉）。
 */
function typing(event: KeyboardEvent): boolean {
  const origin = event.composedPath()[0];
  return (
    origin instanceof HTMLElement &&
    (origin.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(origin.tagName))
  );
}

function onKeyDown(event: KeyboardEvent): void {
  if (typing(event) || event.metaKey || event.ctrlKey || event.altKey) return;
  const step: Partial<Record<string, Partial<View>>> = {
    ArrowLeft: { yaw: view.yaw - 0.15 },
    a: { yaw: view.yaw - 0.15 },
    ArrowRight: { yaw: view.yaw + 0.15 },
    d: { yaw: view.yaw + 0.15 },
    ArrowUp: { distance: view.distance - 1 },
    w: { distance: view.distance - 1 },
    ArrowDown: { distance: view.distance + 1 },
    s: { distance: view.distance + 1 },
  };
  const change = step[event.key];
  if (change === undefined) return;
  event.preventDefault();
  update({ ...view, ...change });
}

const observer = new ResizeObserver(render);

onMounted(() => {
  observer.observe(canvas.value!);
  window.addEventListener('keydown', onKeyDown);
  canvas.value!.addEventListener('wheel', onWheel, { passive: false });
  window.__model = {
    view: () => ({ ...view }),
    point(id) {
      const device = props.devices.find((candidate) => candidate.id === id)!;
      const rect = canvas.value!.getBoundingClientRect();
      const [x, y] = topCenter(device, view, rect.width, rect.height);
      return { x: rect.left + x, y: rect.top + y };
    },
  };
  render();
});

onBeforeUnmount(() => {
  observer.disconnect();
  window.removeEventListener('keydown', onKeyDown);
  delete window.__model;
});

watch(() => props.selected, render);
</script>

<template>
  <canvas
    ref="canvas"
    class="model"
    tabindex="0"
    role="img"
    aria-label="設備 3D 模型：拖曳旋轉、滾輪縮放、點選設備"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
  />
</template>

<style>
.model {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
  cursor: grab;
  background: radial-gradient(circle at 50% 40%, #1e293b, #0f172a);
}
</style>
