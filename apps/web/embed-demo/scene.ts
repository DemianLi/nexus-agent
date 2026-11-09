/**
 * 測試頁中間那塊「3D 模型」：幾台設備畫成立方體，可以拖曳旋轉、滾輪縮放、點選。不用 3D 套件，canvas 2D 自己投影，
 * 夠模擬可視化系統的互動（指標、滾輪、鍵盤都在宿主頁手上），不求畫得好看。
 */

/** 一台設備。`x`、`z` 是地面上的位置，`height` 是高度，單位都是格。 */
export interface Device {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly z: number;
  readonly height: number;
  readonly color: string;
}

export interface View {
  /** 繞垂直軸轉的角度（弧度）。 */
  yaw: number;
  /** 俯角（弧度）。 */
  pitch: number;
  /** 相機離中心的距離。 */
  distance: number;
}

type Vec3 = readonly [number, number, number];
type Point = readonly [number, number];

interface Face {
  readonly device: Device;
  readonly points: readonly Point[];
  readonly depth: number;
  readonly shade: number;
}

const PITCH_MIN = 0.15;
const PITCH_MAX = 1.3;
const DISTANCE_MIN = 6;
const DISTANCE_MAX = 30;

/** 立方體的面：頂點索引與明暗（1 是原色，越小疊上越深的暗色）。 */
const FACES: readonly (readonly [readonly number[], number])[] = [
  [[4, 5, 6, 7], 1],
  [[0, 1, 5, 4], 0.75],
  [[1, 2, 6, 5], 0.6],
  [[2, 3, 7, 6], 0.75],
  [[3, 0, 4, 7], 0.6],
  [[0, 3, 2, 1], 0.4],
];

export function clampView(view: View): View {
  return {
    yaw: view.yaw,
    pitch: Math.min(PITCH_MAX, Math.max(PITCH_MIN, view.pitch)),
    distance: Math.min(DISTANCE_MAX, Math.max(DISTANCE_MIN, view.distance)),
  };
}

function project(point: Vec3, view: View, width: number, height: number): [Point, number] {
  const [x, y, z] = point;
  const cosY = Math.cos(view.yaw);
  const sinY = Math.sin(view.yaw);
  const rx = x * cosY - z * sinY;
  const rz = x * sinY + z * cosY;
  const cosP = Math.cos(view.pitch);
  const sinP = Math.sin(view.pitch);
  const ry = y * cosP + rz * sinP;
  const depth = rz * cosP - y * sinP + view.distance;
  const scale = (Math.min(width, height) * 1.1) / depth;
  return [[width / 2 + rx * scale, height * 0.55 - ry * scale], depth];
}

function cube(device: Device): Vec3[] {
  const { x, z, height } = device;
  const half = 0.6;
  return [
    [x - half, 0, z - half],
    [x + half, 0, z - half],
    [x + half, 0, z + half],
    [x - half, 0, z + half],
    [x - half, height, z - half],
    [x + half, height, z - half],
    [x + half, height, z + half],
    [x - half, height, z + half],
  ];
}

/** 投影所有面，由遠到近排好（後畫的蓋住先畫的）。 */
export function layout(
  devices: readonly Device[],
  view: View,
  width: number,
  height: number,
): Face[] {
  const faces: Face[] = [];
  for (const device of devices) {
    const projected = cube(device).map((vertex) => project(vertex, view, width, height));
    for (const [indices, shade] of FACES) {
      faces.push({
        device,
        points: indices.map((index) => projected[index]![0]),
        depth: indices.reduce((sum, index) => sum + projected[index]![1], 0) / indices.length,
        shade,
      });
    }
  }
  return faces.sort((a, b) => b.depth - a.depth);
}

function inside(point: Point, polygon: readonly Point[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi
    ) {
      hit = !hit;
    }
  }
  return hit;
}

/**
 * `faces` 要照 `layout()` 的遠到近順序（`draw()` 的回傳值就是）。回傳點到的設備，重疊時取最近的那一面；沒點到是 `null`。
 */
export function pick(faces: readonly Face[], point: Point): Device | null {
  for (let i = faces.length - 1; i >= 0; i--) {
    if (inside(point, faces[i]!.points)) return faces[i]!.device;
  }
  return null;
}

/** 設備頂面中心在畫布上的位置（給 `window.__model.point` 用）。 */
export function topCenter(device: Device, view: View, width: number, height: number): Point {
  return project([device.x, device.height, device.z], view, width, height)[0];
}

/** 畫地面格線與所有設備，回傳 `layout()` 排好的面（遠到近），給 `pick()` 用。 */
export function draw(
  context: CanvasRenderingContext2D,
  devices: readonly Device[],
  view: View,
  selected: string | null,
  width: number,
  height: number,
): Face[] {
  context.clearRect(0, 0, width, height);
  context.strokeStyle = 'rgba(148, 163, 184, 0.35)';
  context.lineWidth = 1;
  for (let i = -5; i <= 5; i++) {
    for (const [from, to] of [
      [
        [i, 0, -5],
        [i, 0, 5],
      ],
      [
        [-5, 0, i],
        [5, 0, i],
      ],
    ] as const) {
      const [a] = project(from, view, width, height);
      const [b] = project(to, view, width, height);
      context.beginPath();
      context.moveTo(...a);
      context.lineTo(...b);
      context.stroke();
    }
  }
  const faces = layout(devices, view, width, height);
  for (const face of faces) {
    context.beginPath();
    face.points.forEach((point, index) =>
      index === 0 ? context.moveTo(...point) : context.lineTo(...point),
    );
    context.closePath();
    context.fillStyle = face.device.color;
    context.fill();
    context.fillStyle = `rgba(15, 23, 42, ${1 - face.shade})`;
    context.fill();
    const isSelected = face.device.id === selected;
    context.strokeStyle = isSelected ? '#fde047' : 'rgba(15, 23, 42, 0.6)';
    context.lineWidth = isSelected ? 3 : 1;
    context.stroke();
  }
  return faces;
}
