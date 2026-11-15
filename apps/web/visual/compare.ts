/**
 * 視覺回歸的比對（#2766）：兩個目錄的截圖（`shoot.ts` 拍的）逐張比，列出有差的畫面。**只報告，結束碼一律 0。**
 *
 * 用法：`node visual/compare.ts <上一個 commit 的截圖> <這個 commit 的截圖> <輸出目錄>`。
 * 摘要（Markdown）寫到 `<輸出目錄>/summary.md` 並印到 stdout；有差的畫面各存三張：前、後、差在哪（洋紅）。
 *
 * 同一份畫面連拍兩次也會有雜訊：零星、互不相鄰的單一像素（反鋸齒、漸層的抖色）。真的改動會連成一塊，
 * 所以只數**跟另一個不同像素相鄰**的那些；這種像素不超過 `NOISE_PIXELS` 個，算沒變。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { chromium } from 'playwright-core';

/**
 * 相鄰成塊的不同像素不超過這個數，算雜訊。CI 的 Linux runner 上，畫面沒改的 commit 也量到 8–15 個成塊的
 * （一條分隔線的邊、文字的邊，色差 16 以內），所以留到 30；真的改動（一顆按鈕的圓角）是幾百個起跳。
 */
const NOISE_PIXELS = 30;

interface Diff {
  /** 不同的像素數。 */
  pixels: number;
  /** 其中跟另一個不同像素相鄰（八個方向）的。 */
  clustered: number;
  /** 最大的色差。 */
  delta: number;
  /** 不同的像素落在哪個範圍。 */
  box: string;
  /** 標出差異的圖（PNG 的 base64）；尺寸不同時沒有。 */
  image: string | null;
}

const [baseArg, headArg, outArg] = process.argv.slice(2);
if (baseArg === undefined || headArg === undefined || outArg === undefined) {
  throw new Error('用法：node visual/compare.ts <上一個的截圖> <這一個的截圖> <輸出目錄>');
}
const base = resolve(baseArg);
const head = resolve(headArg);
const out = resolve(outArg);
mkdirSync(out, { recursive: true });

const shots = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.png'))
        .sort()
    : [];
const errorsOf = (dir: string): Record<string, string> => {
  const file = join(dir, 'errors.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>) : {};
};

const baseShots = shots(base);
const headShots = shots(head);
const added = headShots.filter((f) => !baseShots.includes(f));
const removed = baseShots.filter((f) => !headShots.includes(f));
const common = headShots.filter((f) => baseShots.includes(f));

const changed: { name: string; diff: Diff }[] = [];
let noisy = 0;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  for (const file of common) {
    const before = readFileSync(join(base, file));
    const after = readFileSync(join(head, file));
    if (before.equals(after)) continue;
    const diff = await page.evaluate(
      async ([a, b]): Promise<Diff> => {
        const load = async (b64: string) => {
          const img = new Image();
          img.src = `data:image/png;base64,${b64}`;
          await img.decode();
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          if (ctx === null) throw new Error('拿不到 canvas 的 2d context');
          ctx.drawImage(img, 0, 0);
          return { ctx, canvas, data: ctx.getImageData(0, 0, img.width, img.height) };
        };
        const [p, q] = await Promise.all([load(a ?? ''), load(b ?? '')]);
        if (p.canvas.width !== q.canvas.width || p.canvas.height !== q.canvas.height) {
          return {
            pixels: Infinity,
            clustered: Infinity,
            delta: Infinity,
            box: `尺寸 ${p.canvas.width}×${p.canvas.height} → ${q.canvas.width}×${q.canvas.height}`,
            image: null,
          };
        }
        const width = q.canvas.width;
        const height = q.canvas.height;
        const differs = new Uint8Array(width * height);
        const marked = q.ctx.createImageData(q.data);
        let pixels = 0;
        let delta = 0;
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -1;
        let y1 = -1;
        for (let i = 0; i < p.data.data.length; i += 4) {
          const d =
            Math.abs((p.data.data[i] ?? 0) - (q.data.data[i] ?? 0)) +
            Math.abs((p.data.data[i + 1] ?? 0) - (q.data.data[i + 1] ?? 0)) +
            Math.abs((p.data.data[i + 2] ?? 0) - (q.data.data[i + 2] ?? 0));
          if (d === 0) {
            // 沒變的地方淡掉，差異才看得出來。
            for (let c = 0; c < 3; c++) {
              marked.data[i + c] = 255 - (255 - (q.data.data[i + c] ?? 0)) / 4;
            }
            marked.data[i + 3] = 255;
            continue;
          }
          pixels += 1;
          differs[i / 4] = 1;
          delta = Math.max(delta, d);
          const x = (i / 4) % width;
          const y = Math.floor(i / 4 / width);
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
          marked.data.set([255, 0, 255, 255], i);
        }
        let clustered = 0;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            if (differs[y * width + x] !== 1) continue;
            let near = false;
            for (let dy = -1; dy <= 1 && !near; dy++) {
              for (let dx = -1; dx <= 1 && !near; dx++) {
                const nx = x + dx;
                const ny = y + dy;
                if ((dx !== 0 || dy !== 0) && nx >= 0 && nx < width && ny >= 0 && ny < height) {
                  near = differs[ny * width + nx] === 1;
                }
              }
            }
            if (near) clustered += 1;
          }
        }
        q.ctx.putImageData(marked, 0, 0);
        return {
          pixels,
          clustered,
          delta,
          box: `(${x0}, ${y0})–(${x1}, ${y1})`,
          image: q.canvas.toDataURL('image/png').split(',')[1] ?? null,
        };
      },
      [before.toString('base64'), after.toString('base64')],
    );
    if (diff.clustered <= NOISE_PIXELS) {
      noisy += 1;
      continue;
    }
    const name = file.replace(/\.png$/, '');
    changed.push({ name, diff });
    copyFileSync(join(base, file), join(out, `${name}.before.png`));
    copyFileSync(join(head, file), join(out, `${name}.after.png`));
    if (diff.image !== null) {
      writeFileSync(join(out, `${name}.diff.png`), Buffer.from(diff.image, 'base64'));
    }
  }
} finally {
  await browser.close();
}

const failed = { ...errorsOf(base), ...errorsOf(head) };
const label = (sha: string | undefined) =>
  sha === undefined || sha === '' ? '?' : sha.slice(0, 8);
const lines = [
  '### 視覺差異（只報告，不擋）',
  '',
  `上一個 commit \`${label(process.env.VISUAL_BASE)}\` → 這個 commit \`${label(process.env.VISUAL_HEAD)}\`：比了 ${common.length} 個畫面，` +
    `**${changed.length} 個有差**，${noisy} 個只有零星的雜訊（相鄰成塊的不同像素不超過 ${NOISE_PIXELS} 個）。`,
  '',
];
if (changed.length > 0) {
  lines.push(
    '| 畫面 | 不同的像素 | 其中成塊的 | 最大色差 | 範圍 |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const { name, diff } of changed) {
    lines.push(
      `| \`${name}\` | ${Number.isFinite(diff.pixels) ? diff.pixels : '—'} | ${Number.isFinite(diff.clustered) ? diff.clustered : '—'} | ${Number.isFinite(diff.delta) ? diff.delta : '—'} | ${diff.box} |`,
    );
  }
  lines.push('', '前、後與標出差異的圖在這一輪的 artifact `visual-diff`。', '');
}
if (added.length > 0) lines.push(`新增的畫面：${added.map((f) => `\`${f}\``).join('、')}`, '');
if (removed.length > 0) lines.push(`不見的畫面：${removed.map((f) => `\`${f}\``).join('、')}`, '');
if (Object.keys(failed).length > 0) {
  lines.push(
    '沒拍成的：',
    ...Object.entries(failed).map(([k, v]) => `- \`${k}\`：${v.split('\n')[0]}`),
    '',
  );
}
const summary = `${lines.join('\n')}\n`;
writeFileSync(join(out, 'summary.md'), summary);
console.log(summary);
