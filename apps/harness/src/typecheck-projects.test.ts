import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  renderProject,
  typecheckProjects,
  uncoveredDirs,
} from '../../../scripts/gen-typecheck-projects.js';
import { ROOT } from '../../../scripts/workspace-packages.js';

/**
 * 型別檢查的 project references（#2096）。references 少一條，下游讀不到上游的宣告檔就紅；漏掉一個套件，CI 少查它卻照樣綠。
 * 期望值直接讀 `package.json`，不經產生器借用的 `workspacePackages()`。
 */

function manifests(): Map<string, { name: string; deps: string[] }> {
  const found = new Map<string, { name: string; deps: string[] }>();
  for (const parent of ['packages', 'apps']) {
    for (const name of readdirSync(join(ROOT, parent))) {
      const dir = `${parent}/${name}`;
      let raw: string;
      try {
        raw = readFileSync(join(ROOT, dir, 'package.json'), 'utf8');
      } catch {
        continue;
      }
      const manifest = JSON.parse(raw) as Record<string, unknown> & { name: string };
      const deps = [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ].flatMap((field) => Object.keys((manifest[field] as object | undefined) ?? {}));
      found.set(dir, { name: manifest.name, deps });
    }
  }
  return found;
}

describe('對著真的 repo', () => {
  const projects = typecheckProjects();

  it('packages/* 與 apps/* 除了 web 都有一份', () => {
    expect(projects.map((project) => project.dir).sort()).toEqual(
      [...manifests().keys()].filter((dir) => dir !== 'apps/web').sort(),
    );
    expect(uncoveredDirs(projects)).toEqual([]);
  });

  it('references 是 package.json 宣告的 workspace 相依，被引用的才開 composite', () => {
    const all = manifests();
    const dirOf = new Map([...all].map(([dir, { name }]) => [name, dir]));
    const referenced = new Set<string>();
    for (const project of projects) {
      const expected = [
        ...new Set(
          (all.get(project.dir)?.deps ?? []).flatMap((name) => {
            const dir = dirOf.get(name);
            return dir === undefined || dir === project.dir || dir === 'apps/web' ? [] : [dir];
          }),
        ),
      ].sort();
      expect(project.references, project.dir).toEqual(expected);
      for (const dir of expected) referenced.add(dir);
    }
    for (const project of projects) {
      expect(project.composite, project.dir).toBe(referenced.has(project.dir));
    }
  });
});

describe('擋得住', () => {
  it('漏掉的套件會被點名', () => {
    const projects = typecheckProjects().filter(
      (project) => project.dir !== 'packages/nexus-deque',
    );
    expect(uncoveredDirs(projects)).toEqual(['packages/nexus-deque']);
  });
});

describe('產生的設定', () => {
  it('composite 的只輸出宣告檔，extends 套件自己的 tsconfig', () => {
    expect(
      JSON.parse(
        renderProject({
          dir: 'packages/nexus-core',
          composite: true,
          references: ['packages/nexus-brand'],
        }),
      ),
    ).toEqual({
      extends: '../../../tsconfig.json',
      compilerOptions: {
        composite: true,
        noEmit: false,
        emitDeclarationOnly: true,
        rootDir: '../../../../..',
        outDir: 'out',
        tsBuildInfoFile: 'tsconfig.tsbuildinfo',
      },
      references: [
        { path: '../../../../nexus-brand/node_modules/.cache/nexus-typecheck/tsconfig.json' },
      ],
    });
  });

  it('沒人引用的只開 incremental', () => {
    expect(
      JSON.parse(renderProject({ dir: 'apps/harness', composite: false, references: [] })),
    ).toEqual({
      extends: '../../../tsconfig.json',
      compilerOptions: { incremental: true, tsBuildInfoFile: 'tsconfig.tsbuildinfo' },
      references: [],
    });
  });
});
