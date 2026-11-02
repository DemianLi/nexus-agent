/**
 * 舊 thread 寫不得的地方（[#1960](https://github.com/DemianLi/nexus-agent/issues/1960)）：保留清單怎麼算、圍堵 backend 怎麼擋。
 * 從 serve 起量的那一份在 `legacy-thread-shared-guard.test.ts`；這裡量 serve 量不方便的格：唯讀、核准過的 grant、別名、delete 與 uploadFiles；全開兩邊都量。
 */

import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { threadSkillSources } from '@nexus/core';
import type { FsService } from '@nexus/core';
import { SANDBOX_ESCALATION_HINT, SandboxModeController } from '@nexus/plugin-sandbox-policy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContainedFilesystemBackend } from './contained-backend.js';
import type { SandboxMode } from './contained-backend.js';
import { sharedReservedWrites } from './shared-reserved-writes.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join('/var/tmp', 'nexus-reserved-writes-'));
  await writeFile(join(root, 'AGENTS.md'), 'DEPLOY-RULE', 'utf8');
  await mkdir(join(root, 'skills', 'normal'), { recursive: true });
  await writeFile(join(root, 'skills', 'normal', 'SKILL.md'), 'NORMAL', 'utf8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** fold 完的 fs 把手只用到這兩格。 */
function fsOf(skillSources: readonly string[], offWorkspacePrefixes: readonly string[]): FsService {
  return {
    skillSources: () => skillSources,
    offWorkspacePrefixes: () => offWorkspacePrefixes,
  } as FsService;
}

function backendOf(
  mode: SandboxMode | SandboxModeController = 'workspace-write',
  fs: FsService | undefined = fsOf(['/skills/'], ['/large_tool_results']),
): ContainedFilesystemBackend {
  const controller = typeof mode === 'string' ? undefined : mode;
  return new ContainedFilesystemBackend({
    rootDir: root,
    mode: controller?.source ?? (mode as SandboxMode),
    ...(controller !== undefined && { grants: controller }),
    reservedWrites: () => sharedReservedWrites(fs),
  });
}

const exists = async (path: string): Promise<boolean> =>
  (await stat(path).catch(() => undefined)) !== undefined;

describe('sharedReservedWrites', () => {
  it('四個指示檔名只擋根目錄那一個；技能來源去掉落在路由底下的', () => {
    const reserved = sharedReservedWrites(
      fsOf(['/skills/', '/large_tool_results/skills/', '/team-skills'], ['/large_tool_results']),
    );
    expect(reserved.map((entry) => [entry.path, entry.subtree])).toEqual([
      ['/AGENTS.md', false],
      ['/CLAUDE.md', false],
      ['/AGENTS.local.md', false],
      ['/CLAUDE.local.md', false],
      ['/skills/', true],
      ['/team-skills', true],
    ]);
  });

  it('擋的技能目錄，就是新 thread 接到共用區底下的那幾個（#2082）', () => {
    const sources = [
      '/skills/',
      '/team-skills',
      '/routed',
      '/routed/skills/',
      '/routedx/',
      '/mounted/skills',
      '/mountedx',
    ];
    const routes = ['/routed/', '/mounted'];
    const guarded = sharedReservedWrites(fsOf(sources, routes))
      .filter((entry) => entry.subtree)
      .map((entry) => entry.path);
    const rebased = threadSkillSources(sources, {
      sharedWorkspacePrefix: () => '/shared',
      offWorkspacePrefixes: () => routes,
    })
      .filter((source) => source.startsWith('/shared/'))
      .map((source) => source.slice('/shared'.length));
    expect(new Set(guarded)).toEqual(new Set(rebased));
    expect(guarded).toEqual(['/skills/', '/team-skills', '/routedx/', '/mountedx']);
  });

  it('fold 之前（沒有 fs 把手）只有指示檔', () => {
    expect(sharedReservedWrites(undefined).map((entry) => entry.path)).toEqual([
      '/AGENTS.md',
      '/CLAUDE.md',
      '/AGENTS.local.md',
      '/CLAUDE.local.md',
    ]);
  });
});

describe('圍堵 backend 的 reservedWrites', () => {
  it.each(['/AGENTS.md', '/CLAUDE.md', '/AGENTS.local.md', '/CLAUDE.local.md'])(
    '%s：write 與 edit 都被擋，檔案沒動',
    async (path) => {
      const backend = backendOf();
      const written = await backend.write(path, 'LEGACY-RULE');
      expect(written.error).toContain('[containment]');
      expect(written.error).toContain('工作區指示');
      expect((await backend.edit(path, 'DEPLOY-RULE', 'LEGACY-RULE')).error).toContain(
        '工作區指示',
      );
    },
  );

  it('技能來源底下（含子目錄與目錄本身）write、edit 都被擋', async () => {
    const backend = backendOf();
    for (const path of ['/skills/rogue/SKILL.md', '/skills/a/b/c.md', '/skills']) {
      expect((await backend.write(path, 'x')).error).toContain('技能來源');
    }
    expect((await backend.edit('/skills/normal/SKILL.md', 'NORMAL', 'ROGUE')).error).toContain(
      '技能來源',
    );
    expect(await readFile(join(root, 'skills', 'normal', 'SKILL.md'), 'utf8')).toBe('NORMAL');
    expect(await exists(join(root, 'skills', 'rogue'))).toBe(false);
  });

  it('delete 與 uploadFiles 也走同一道', async () => {
    const backend = backendOf();
    expect((await backend.delete('/AGENTS.md')).error).toContain('工作區指示');
    const [uploaded] = await backend.uploadFiles([['/CLAUDE.md', new TextEncoder().encode('x')]]);
    expect(uploaded?.error).toBe('permission_denied');
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('DEPLOY-RULE');
    expect(await exists(join(root, 'CLAUDE.md'))).toBe(false);
  });

  it('其他地方照常：根目錄別的檔、子目錄裡的指示檔名、名字像技能來源的目錄', async () => {
    const backend = backendOf();
    for (const path of ['/notes.md', '/sub/AGENTS.md', '/skillsx/a.md', '/docs/skills/a.md']) {
      expect((await backend.write(path, 'ok')).error).toBeUndefined();
    }
  });

  it('別名也擋：/./、經符號連結、只差大小寫', async () => {
    await symlink('.', join(root, 'docs'));
    const backend = backendOf();
    for (const path of ['/./CLAUDE.md', '/docs/CLAUDE.md', '/claude.md', '/docs/skills/x.md']) {
      expect((await backend.write(path, 'x')).error).toContain('[containment]');
    }
  });

  it.each(['danger-full-access', 'read-only'] as const)(
    '模式是 %s 也照擋，訊息是保留的理由',
    async (mode) => {
      const written = await backendOf(mode).write('/CLAUDE.md', 'x');
      expect(written.error).toContain('工作區指示');
      expect(written.error).toContain(`mode: ${mode}`);
      expect(await exists(join(root, 'CLAUDE.md'))).toBe(false);
    },
  );

  it('有升級時不接指引、不記拒絕、不消費 grant', async () => {
    const controller = new SandboxModeController('read-only');
    controller.enableEscalation(SANDBOX_ESCALATION_HINT);
    const backend = backendOf(controller);
    const grant = { mode: 'danger-full-access', target: '/CLAUDE.md', denied: undefined } as const;
    controller.grant(grant);
    const written = await backend.write('/CLAUDE.md', 'x');
    expect(written.error).toContain('工作區指示');
    expect(written.error).not.toContain(SANDBOX_ESCALATION_HINT);
    expect(controller.lastDenial).toBeUndefined();
    expect(controller.peekGrant()).toBe(grant);
    expect(await exists(join(root, 'CLAUDE.md'))).toBe(false);
  });

  it('沒給 reservedWrites：照舊寫得進去', async () => {
    const backend = new ContainedFilesystemBackend({ rootDir: root });
    expect((await backend.write('/CLAUDE.md', 'x')).error).toBeUndefined();
    expect((await backend.write('/skills/rogue/SKILL.md', 'x')).error).toBeUndefined();
  });

  it('記憶來源：只收共用區底下的，換成舊 thread 看到的路徑；沒有來源時清單不變', () => {
    const fs = fsOf(['/skills/'], []);
    const paths = (sources?: readonly string[]) =>
      sharedReservedWrites(fs, sources).map((entry) => entry.path);
    const added = paths(['/shared/MEMORY.md', '/shared/docs/note.md', '/MEMORY.md', '/sharedx/a']);
    expect(added.filter((path) => !paths().includes(path))).toEqual([
      '/MEMORY.md',
      '/docs/note.md',
    ]);
    expect(paths([])).toEqual(paths());
    const entry = sharedReservedWrites(fs, ['/shared/MEMORY.md']).find(
      (item) => item.path === '/MEMORY.md',
    );
    expect(entry?.subtree).toBe(false);
  });
});
