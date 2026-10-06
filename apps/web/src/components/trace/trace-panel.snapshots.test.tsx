import type { ConversationState, RequestSnapshotsView } from '@nexus/wire';
import { emptyConversation, reduceAll } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RightSidebarToggle } from '@/components/sidebar/right-sidebar';
import {
  TRACE_HEADER_BAD_TEXT,
  TRACE_SNAPSHOT_REASON_TEXT,
  TRACE_SYSTEM_TRUNCATED_TEXT,
  TRACE_TOOLS_DIFF_PREFIX,
} from '@/components/trace/trace-call';
import { createConversationStore } from '@/lib/conversation-store';
import { LAYOUT_KEY_PREFIX } from '@/lib/right-sidebar';
import type { SidebarLayout } from '@/lib/right-sidebar';
import { axeViolations } from '@/test/axe';
import { Script } from '@/test/conversation-frames';
import { memoryStorage, WithRightSidebar } from '@/test/right-sidebar';
import { call, turn, view, withTrajectory } from '@/test/trajectory-fixtures';

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const open: SidebarLayout = { open: true, tabs: [{ kind: 'trace' }], active: 'trace' };
const SYSTEM_TEXT = 'You are a helpful assistant.\n暗號 SYS-CANARY';
const tool = (name: string) => ({
  name,
  description: `${name} 的說明`,
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
});

function mountWith(snapshots: RequestSnapshotsView, callOverrides = {}) {
  const script = new Script();
  const state: ConversationState = withTrajectory(
    reduceAll(emptyConversation(), [script.running(), script.completed()]),
    script,
    view([turn(0, { calls: [call(5, { system: 8, header: 9, ...callOverrides })] })]),
    snapshots,
  );
  localStorage.setItem(LAYOUT_KEY_PREFIX + 't', JSON.stringify(open));
  return render(
    <WithRightSidebar sources={{ conversation: createConversationStore(state) }}>
      <RightSidebarToggle />
    </WithRightSidebar>,
  );
}

const full = (): RequestSnapshotsView => ({
  system: [{ seq: 8, time: 1, reason: 'change', text: SYSTEM_TEXT, chars: SYSTEM_TEXT.length }],
  header: [
    {
      seq: 3,
      time: 1,
      reason: 'initial',
      header: { config: {}, tools: [tool('task'), tool('ls')] },
    },
    {
      seq: 9,
      time: 2,
      reason: 'change',
      header: {
        config: { model: 'm', temperature: 1, topP: 0.95, maxTokens: 16384 },
        tools: [tool('subagent'), tool('ls')],
      },
    },
  ],
});

async function expandCall() {
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: /^模型呼叫 #1/ }));
}

describe('觀測分頁：呼叫列的系統提示詞、取樣設定與工具清單', () => {
  it('收著時不掛全文；展開看到全文與原因', async () => {
    mountWith(full());
    await expandCall();
    expect(screen.queryByText(/SYS-CANARY/)).toBeNull();
    const block = screen.getByTestId('trace-system-text');
    fireEvent.click(within(block).getByRole('button', { name: /^系統提示詞全文（\d+ 字元）/ }));
    expect(block.querySelector('pre')!.textContent).toBe(SYSTEM_TEXT);
    expect(block.textContent).toContain(TRACE_SNAPSHOT_REASON_TEXT.change);
    expect(screen.queryByTestId('trace-system-truncated')).toBeNull();
  });

  it('被截斷的系統提示詞要說「不是全文」', async () => {
    const snaps = full();
    mountWith({
      ...snaps,
      system: [{ ...snaps.system[0]!, text: 'You are', chars: 70_000, truncated: true }],
    });
    await expandCall();
    fireEvent.click(
      within(screen.getByTestId('trace-system-text')).getByRole('button', {
        name: /^系統提示詞全文/,
      }),
    );
    expect(screen.getByTestId('trace-system-truncated').textContent).toBe(
      TRACE_SYSTEM_TRUNCATED_TEXT,
    );
  });

  it('取樣設定逐項列出、工具清單列出名字與相對上一份的差異，點工具看說明與參數', async () => {
    mountWith(full());
    await expandCall();
    fireEvent.click(
      within(screen.getByTestId('trace-header-block')).getByRole('button', {
        name: /^取樣設定與工具清單（工具 2 個）/,
      }),
    );
    const config = screen.getByTestId('trace-header-config').textContent!;
    expect(config).toContain('temperature1');
    expect(config).toContain('topP0.95');
    expect(config).toContain('maxTokens16384');
    expect(screen.getByTestId('trace-header-diff').textContent).toBe(
      `${TRACE_TOOLS_DIFF_PREFIX}新增 subagent；移除 task`,
    );
    const tools = screen.getAllByTestId('trace-header-tool');
    expect(tools.map((t) => t.querySelector('code')!.textContent)).toEqual(['subagent', 'ls']);
    expect(screen.queryByText('subagent 的說明')).toBeNull();
    fireEvent.click(within(tools[0]!).getByRole('button', { name: 'subagent' }));
    expect(screen.getByText('subagent 的說明')).toBeTruthy();
    expect(tools[0]!.querySelector('pre')!.textContent).toContain('"properties"');
  });

  it('快照已被擠掉或沒記：沒有這兩個區塊，摘要那兩行照舊', async () => {
    mountWith({ system: [], header: [] });
    await expandCall();
    expect(screen.queryByTestId('trace-system-text')).toBeNull();
    expect(screen.queryByTestId('trace-header-block')).toBeNull();
    expect(screen.getByTestId('trace-call-details').textContent).toContain('系統提示詞已不保留');
  });

  it('設定與工具清單讀不出來時說讀不出來，不拋', async () => {
    mountWith({
      system: [],
      header: [{ seq: 9, time: 2, reason: 'initial', header: 42 }],
    });
    await expandCall();
    fireEvent.click(
      within(screen.getByTestId('trace-header-block')).getByRole('button', {
        name: /^取樣設定與工具清單/,
      }),
    );
    expect(screen.getByText(TRACE_HEADER_BAD_TEXT)).toBeTruthy();
  });

  it('展開後沒有無障礙違規', async () => {
    const { container } = mountWith(full());
    await expandCall();
    fireEvent.click(
      within(screen.getByTestId('trace-system-text')).getByRole('button', {
        name: /^系統提示詞全文/,
      }),
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it('呼叫沒有正常回來：標題列寫失敗或已中止，展開多一行「結果」；正常的沒有', async () => {
    mountWith({ system: [], header: [] }, { outcome: 'error' });
    await act(async () => {});
    expect(screen.getByTestId('trace-call-outcome').textContent).toContain('失敗');
    fireEvent.click(screen.getByRole('button', { name: /^模型呼叫 #1/ }));
    expect(screen.getByTestId('trace-call-details').textContent).toContain('結果失敗');
    cleanup();
    mountWith({ system: [], header: [] }, { outcome: 'aborted' });
    await act(async () => {});
    expect(screen.getByTestId('trace-call-outcome').textContent).toContain('已中止');
    cleanup();
    mountWith({ system: [], header: [] });
    await act(async () => {});
    expect(screen.queryByTestId('trace-call-outcome')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^模型呼叫 #1/ }));
    expect(screen.getByTestId('trace-call-details').textContent).not.toContain('結果');
  });
});
