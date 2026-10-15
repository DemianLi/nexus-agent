import { readFileSync } from 'node:fs';

import * as core from '@nexus/core';
import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import type { EntryOptions } from '@nexus/cordis-plugin-loader';
import { injectOf, need, service } from '@nexus/sdk';
import type { ContractService } from '@nexus/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import {
  APPROVAL_CHANNEL_CONTRACT_VERSION,
  approvalChannelToken,
  CHANNEL_FOR_THREAD_SERVICE,
  CHANNEL_SERVICE,
  QUESTION_INTERRUPT_KIND,
} from './index.js';
import type { ApprovalChannelService } from './index.js';
import { createApprovalChannelProvider } from './provider.js';

/** 消費者：`inject` 宣告必要依賴；`apply` 當下抓住服務。另一顆要的範圍不含 1.0.0（用來看契約檢查）。 */
function consumers(captured: { held?: ApprovalChannelService }) {
  return {
    required: {
      name: 'channel-required',
      inject: injectOf(need(approvalChannelToken, '^1.0.0')),
      apply(ctx: Context) {
        captured.held = service(ctx, approvalChannelToken);
      },
    },
    incompatible: {
      name: 'channel-incompatible',
      inject: injectOf(need(approvalChannelToken, '^2.0.0')),
      apply() {},
    },
  };
}

let root: Context | undefined;
afterEach(async () => {
  await root?.fiber.dispose();
  root = undefined;
});

async function boot(channel: Parameters<typeof createApprovalChannelProvider>[0]) {
  const captured: { held?: ApprovalChannelService } = {};
  const context = new Context();
  root = context;
  await context.plugin(Loader);
  Object.assign(context.loader.builtins, {
    ...consumers(captured),
    'approval-channel': createApprovalChannelProvider(channel).Provider,
  });
  const create = (options: EntryOptions) =>
    context.loader.create(options as Omit<EntryOptions, 'id'>, null);
  await create({ id: 'approval-channel', name: 'cordis:approval-channel' });
  return { captured, loader: context.loader, create };
}

describe('@nexus/approval-channel 的定義', () => {
  it('token 名是 approvalChannel，契約版本是 semver 常數', () => {
    expect(approvalChannelToken).toEqual({
      name: 'approvalChannel',
      version: APPROVAL_CHANNEL_CONTRACT_VERSION,
    });
    expect(APPROVAL_CHANNEL_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('轉出的名字與 core 是同一個值（單向轉出，不是複製）', () => {
    expect(CHANNEL_FOR_THREAD_SERVICE).toBe(core.CHANNEL_FOR_THREAD_SERVICE);
    expect(CHANNEL_SERVICE).toBe(core.CHANNEL_SERVICE);
    expect(QUESTION_INTERRUPT_KIND).toBe(core.QUESTION_INTERRUPT_KIND);
  });

  it('三角色：定義套件把 @nexus/core 放 peer、不進 dependencies（不能讓安裝結果出現第二份 core）', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.peerDependencies['@nexus/core']).toBe('workspace:*');
    expect(manifest.peerDependencies['@nexus/sdk']).toBe('workspace:*');
    expect(manifest.devDependencies['@nexus/core']).toBe('workspace:*');
  });
});

describe('提供者', () => {
  it('把宿主交進來的值原樣交出去；交進來的物件之後被改不影響已交出去的值', () => {
    const channel = { kind: 'policy-never' } as { kind: 'policy-never' | 'human' };
    const handle = createApprovalChannelProvider(channel);
    channel.kind = 'human';
    expect(handle.channel).toEqual({ kind: 'policy-never' });
    expect(Object.isFrozen(handle.channel)).toBe(true);
  });

  it('消費者掛上時讀到宿主給的值；服務是契約服務（provider 與 contractVersion 對）', async () => {
    const { captured, loader, create } = await boot({ kind: 'policy-never' });
    await create({ id: 'row-required', name: 'cordis:required' });
    await loader.await();
    expect(captured.held?.current()).toEqual({ kind: 'policy-never' });
    const withMeta = captured.held as unknown as ContractService;
    expect(withMeta.provider).toBe('approval-channel');
    expect(withMeta.contractVersion).toBe(APPROVAL_CHANNEL_CONTRACT_VERSION);
  });

  it('宿主沒有指定答題者（undefined）：服務照樣在，消費者照常掛上，current() 回 undefined（由消費者在呼叫當下拒絕）', async () => {
    const { captured, loader, create } = await boot(undefined);
    await create({ id: 'row-required', name: 'cordis:required' });
    await loader.await();
    expect(loader.resolve('row-required').fiber?.ctx.fiber.state).toBe(2);
    expect(captured.held?.current()).toBeUndefined();
  });

  it('契約範圍由 Cordis 擋：要 ^2.0.0 的消費者卡在 PENDING，不拿到 1.x 的服務', async () => {
    const { loader, create } = await boot({ kind: 'human' });
    await create({ id: 'row-incompatible', name: 'cordis:incompatible' });
    await loader.await();
    expect(loader.resolve('row-incompatible').fiber?.ctx.fiber.state).toBe(0);
  });

  it('提供者那一列卸載之後，消費者在 apply 當下抓住的那份仍可呼叫（方法是閉包 own property，不碰 this.ctx）', async () => {
    const { captured, loader, create } = await boot({ kind: 'human' });
    await create({ id: 'row-required', name: 'cordis:required' });
    await loader.await();
    const held = captured.held;
    await loader.resolve('approval-channel').fiber?.ctx.fiber.dispose();
    // root 上的服務確實撤了……
    expect(root?.get(approvalChannelToken.name, false)).toBeUndefined();
    // ……但抓住的那份還答得出來（#1456 驗收 D 的同一個形狀）。
    expect(held?.current()).toEqual({ kind: 'human' });
  });
});
