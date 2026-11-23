import { describe, expect, it } from 'vitest';

import {
  acceleratorLabel,
  isAcceleratedEnter,
  resolveSubmitMode,
  runningSendHint,
} from './submit-mode';

const enter = { key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };

describe('resolveSubmitMode（#710，照 dsh resolveSubmitMode）', () => {
  it('跑著時 Cmd/Ctrl+Enter 插話，Enter 排隊', () => {
    expect(resolveSubmitMode('running', 'accelerated')).toBe('steer');
    expect(resolveSubmitMode('running', 'enter')).toBe('queue');
  });

  it('沒在跑一律排隊', () => {
    for (const status of ['idle', 'stopped', 'failed', 'awaiting-input'] as const) {
      expect(resolveSubmitMode(status, 'accelerated')).toBe('queue');
      expect(resolveSubmitMode(status, 'enter')).toBe('queue');
    }
  });
});

describe('isAcceleratedEnter', () => {
  it('剛好 Ctrl 或 Cmd 其中一個才算', () => {
    expect(isAcceleratedEnter({ ...enter, ctrlKey: true })).toBe(true);
    expect(isAcceleratedEnter({ ...enter, metaKey: true })).toBe(true);
    expect(isAcceleratedEnter(enter)).toBe(false);
    expect(isAcceleratedEnter({ ...enter, ctrlKey: true, metaKey: true })).toBe(false);
    expect(isAcceleratedEnter({ ...enter, ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isAcceleratedEnter({ ...enter, metaKey: true, altKey: true })).toBe(false);
    expect(isAcceleratedEnter({ ...enter, key: 'a', ctrlKey: true })).toBe(false);
  });
});

describe('底列提示', () => {
  it('蘋果的平台寫 ⌘，其餘寫 Ctrl+', () => {
    expect(acceleratorLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('⌘');
    expect(acceleratorLabel('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('⌘');
    expect(acceleratorLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Ctrl+');
    expect(runningSendHint('Mozilla/5.0 (X11; Linux x86_64)')).toEqual({
      text: 'Enter 排隊',
      wide: '・Ctrl+Enter 插話',
    });
  });
});
