import { describe, expect, it } from 'vitest';

import {
  ARCHIVED_BANNER_TEXT,
  ARCHIVED_RESTORE_LABEL,
  BLOCKED_HINT_TEXT,
  isArchivedThread,
} from '@/lib/archived-view';
import { ENDING_LABEL } from '@/lib/trace-view';
import { SETTLED_NOTICE_TEXT } from '@/lib/queue-view';
import { TURN_END_LABEL } from '@/lib/trajectory-view';
import { PROMPT_REJECTED_TEXT } from '@/lib/goal-bar';

describe('封存會話的判斷與用詞（#633）', () => {
  it('在封存集合裡才算；不知道（沒有集合）就不擋，擋的責任落回伺服器', () => {
    expect(isArchivedThread(new Set(['a']), 'a')).toBe(true);
    expect(isArchivedThread(new Set(['a']), 'b')).toBe(false);
    expect(isArchivedThread(undefined, 'a')).toBe(false);
  });

  it('同一件事在各處的說法一致：橫幅、泡泡提示、軌跡收尾、背景子代理結算、目標列都講「會話已封存」／「已封存」', () => {
    expect(ARCHIVED_BANNER_TEXT).toContain('已封存');
    expect(ARCHIVED_RESTORE_LABEL).toBe('取消封存');
    expect(BLOCKED_HINT_TEXT).toContain('已封存');
    expect(BLOCKED_HINT_TEXT).toContain('沒有送給模型');
    expect(ENDING_LABEL.blocked).toBe(TURN_END_LABEL.blocked);
    expect(ENDING_LABEL.blocked).toContain('會話已封存');
    expect(SETTLED_NOTICE_TEXT.refusal).toContain('會話已封存');
    expect(PROMPT_REJECTED_TEXT).toContain('會話已封存');
  });

  it('被擋下不是失敗：收尾標籤不是「失敗」', () => {
    expect(ENDING_LABEL.blocked).not.toBe(ENDING_LABEL.failed);
  });
});
