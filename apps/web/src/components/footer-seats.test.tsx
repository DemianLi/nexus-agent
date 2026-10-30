import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ModelSeat } from '@/components/model-seat';
import { PermissionSeat } from '@/components/permission-seat';
import type { ModelSeat as ModelSeatData } from '@/hooks/use-model-seat';
import type { PermissionSeat as PermissionSeatData } from '@/hooks/use-permission-seat';

/**
 * 底列的 Pick 開著時被收起（#1591 PR 2）：輸入框被核准或提問面板換掉（`hidden`）、一輪開始跑（權限鎖住）時清單跟著關，
 * 回來或解鎖後不自己打開。清單 portal 在 body 上，不收的話會浮在面板上面；開著的 state 沒清掉，回來時會自己冒出來。
 * App 有沒有把 `hidden` 接上在 `App.seats.test.tsx` 驗。
 */

afterEach(cleanup);

const menu = () => screen.queryByRole('menu');

const PERMISSIONS: PermissionSeatData = {
  catalog: {
    options: [
      { value: 'read-only', name: '唯讀' },
      { value: 'workspace-write', name: '可寫工作區' },
    ],
    defaultOptions: [{ value: 'workspace-write', name: '可寫工作區' }],
    defaultPreset: 'workspace-write',
  },
  currentValue: 'workspace-write',
};

const MODELS: ModelSeatData = {
  catalog: {
    default: { modelId: 'model-b' },
    models: [
      { id: 'model-a', name: 'Alpha' },
      {
        id: 'model-b',
        name: 'Beta',
        reasoning: {
          efforts: [
            { id: 'low', name: '低' },
            { id: 'high', name: '高' },
          ],
          defaultEffort: 'low',
        },
      },
    ],
  },
  selection: { modelId: 'model-b' },
  select: async () => undefined,
};

describe('權限那顆', () => {
  const seat = (props: { locked?: string; hidden?: boolean } = {}) => (
    <PermissionSeat
      seat={PERMISSIONS}
      locked={props.locked}
      onSwitch={() => {}}
      hidden={props.hidden ?? false}
    />
  );
  const open = () => fireEvent.click(screen.getByRole('button', { name: /^權限：/ }));

  it('清單開著時輸入框被換掉：清單收起，回來時不自己打開', () => {
    const { rerender } = render(seat());
    open();
    expect(menu()).not.toBeNull();
    rerender(seat({ hidden: true }));
    expect(menu()).toBeNull();
    rerender(seat());
    expect(menu()).toBeNull();
  });

  it('清單開著時一輪開始跑（鎖住）：清單收起，解鎖時不自己打開', () => {
    const { rerender } = render(seat());
    open();
    expect(menu()).not.toBeNull();
    rerender(seat({ locked: '這一輪結束後才能切換。' }));
    expect(menu()).toBeNull();
    rerender(seat());
    expect(menu()).toBeNull();
  });
});

describe('模型與推理強度', () => {
  /** 模型那顆的 `open` 在呼叫端（App 的 `/model` 要打得開它），這裡照 App 的接法自己拿著。 */
  function Host({ hidden }: { hidden: boolean }) {
    const [open, setOpen] = useState(false);
    return <ModelSeat seat={MODELS} open={open} onOpenChange={setOpen} hidden={hidden} />;
  }

  it.each([
    ['模型', /^模型：/],
    ['推理強度', /^推理強度：/],
  ])('%s的清單開著時輸入框被換掉：清單收起，回來時不自己打開', (_name, trigger) => {
    const { rerender } = render(<Host hidden={false} />);
    fireEvent.click(screen.getByRole('button', { name: trigger }));
    expect(menu()).not.toBeNull();
    rerender(<Host hidden />);
    expect(menu()).toBeNull();
    rerender(<Host hidden={false} />);
    expect(menu()).toBeNull();
  });
});
