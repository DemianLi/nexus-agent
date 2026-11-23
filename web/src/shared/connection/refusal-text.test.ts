import {
  SERVER_CLOSING,
  THREAD_AT_CAPACITY,
  THREAD_HISTORY_TOO_DEEP,
  THREAD_IS_SUBAGENT,
  THREAD_LOG_BUSY,
  THREAD_LOG_TOO_LARGE,
  THREAD_NOT_EMBEDDED,
  THREAD_NOT_OWNED,
  THREAD_ROOT_MISMATCH,
  THREAD_WRITER_HELD,
} from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { NEW_CONVERSATION_LABEL } from '@/app/embed/embedded-chat';
import {
  refusal,
  refusalText,
  SERVER_CLOSING_TEXT,
  THREAD_AT_CAPACITY_TEXT,
  THREAD_HISTORY_TOO_DEEP_TEXT,
  THREAD_IS_SUBAGENT_TEXT,
  THREAD_LOG_BUSY_TEXT,
  THREAD_LOG_TOO_LARGE_TEXT,
  THREAD_NOT_EMBEDDED_TEXT,
  THREAD_NOT_OWNED_TEXT,
  THREAD_ROOT_MISMATCH_TEXT,
  THREAD_WRITER_HELD_TEXT,
} from '@/shared/connection/refusal-text';
import type { RefusalMoment } from '@/shared/connection/refusal-text';

const ALL: readonly RefusalMoment[] = ['opening', 'sending', 'reading'];

const TABLE: readonly {
  code: string;
  text: string;
  permanent: boolean;
  during: readonly RefusalMoment[];
}[] = [
  { code: THREAD_AT_CAPACITY, text: THREAD_AT_CAPACITY_TEXT, permanent: false, during: ALL },
  {
    code: THREAD_HISTORY_TOO_DEEP,
    text: THREAD_HISTORY_TOO_DEEP_TEXT,
    permanent: true,
    during: ALL,
  },
  { code: THREAD_LOG_TOO_LARGE, text: THREAD_LOG_TOO_LARGE_TEXT, permanent: true, during: ALL },
  { code: THREAD_LOG_BUSY, text: THREAD_LOG_BUSY_TEXT, permanent: false, during: ALL },
  { code: THREAD_WRITER_HELD, text: THREAD_WRITER_HELD_TEXT, permanent: false, during: ALL },
  { code: THREAD_ROOT_MISMATCH, text: THREAD_ROOT_MISMATCH_TEXT, permanent: true, during: ALL },
  { code: SERVER_CLOSING, text: SERVER_CLOSING_TEXT, permanent: false, during: ['sending'] },
  {
    code: THREAD_IS_SUBAGENT,
    text: THREAD_IS_SUBAGENT_TEXT,
    permanent: true,
    during: ['opening'],
  },
  {
    code: THREAD_NOT_EMBEDDED,
    text: THREAD_NOT_EMBEDDED_TEXT,
    permanent: true,
    during: ['opening'],
  },
  { code: THREAD_NOT_OWNED, text: THREAD_NOT_OWNED_TEXT, permanent: true, during: ['opening'] },
];

describe('refusal：表的每一列在每個情境認不認', () => {
  for (const row of TABLE) {
    for (const moment of ALL) {
      const knows = row.during.includes(moment);
      it(`${row.code}／${moment}：${knows ? '認' : '不認'}`, () => {
        if (knows) {
          expect(refusal(row.code, moment)).toEqual({ text: row.text, permanent: row.permanent });
          expect(refusalText(row.code, moment)).toBe(row.text);
        } else {
          expect(refusal(row.code, moment)).toBeUndefined();
          expect(refusalText(row.code, moment)).toBeUndefined();
        }
      });
    }
  }

  it.each(ALL)('%s：其他碼與沒有碼回 undefined，照各處原本的講法', (moment) => {
    expect(refusal('unknown_error', moment)).toBeUndefined();
    expect(refusal('thread_not_found', moment)).toBeUndefined();
    expect(refusalText(undefined, moment)).toBeUndefined();
  });

  it('十句各不相同', () => {
    expect(new Set(TABLE.map((row) => row.text)).size).toBe(TABLE.length);
  });
});

describe('文案', () => {
  it('thread 數滿了：提管理者，不提上限數字，也不提重啟（#1478）', () => {
    expect(THREAD_AT_CAPACITY_TEXT).toContain('管理者');
    expect(THREAD_AT_CAPACITY_TEXT).not.toMatch(/\d/u);
    expect(THREAD_AT_CAPACITY_TEXT).not.toContain('重啟');
    expect(THREAD_AT_CAPACITY_TEXT).not.toContain('serve');
  });

  it('歷史太深：講打不開、指向新對話，不提層數、上限、thread 或日誌（#1753）', () => {
    expect(THREAD_HISTORY_TOO_DEEP_TEXT).toContain('打不開');
    expect(THREAD_HISTORY_TOO_DEEP_TEXT).toContain('新的對話');
    expect(THREAD_HISTORY_TOO_DEEP_TEXT).not.toMatch(/thread|wire|日誌|上限|層|\d/iu);
  });

  it.each([THREAD_LOG_TOO_LARGE_TEXT, THREAD_LOG_BUSY_TEXT])(
    '%s：說對話沒有壞、提管理者，不提數字與 serve 的用語（#2203）',
    (text) => {
      expect(text).toContain('對話沒有壞');
      expect(text).toContain('管理者');
      expect(text).not.toMatch(/\d/u);
      expect(text).not.toMatch(/serve|額度|日誌|重啟/u);
    },
  );

  it('只有暫時的那一句叫人稍後再試（#2203）', () => {
    expect(THREAD_LOG_BUSY_TEXT).toContain('稍後再試');
    expect(THREAD_LOG_TOO_LARGE_TEXT).not.toContain('再試');
  });

  it('被別的寫入者握著：說對話沒有壞與下一步，不提數字與 serve 的用語（#2214）', () => {
    expect(THREAD_WRITER_HELD_TEXT).toContain('對話沒有壞');
    expect(THREAD_WRITER_HELD_TEXT).toContain('再試');
    expect(THREAD_WRITER_HELD_TEXT).not.toMatch(/\d/u);
    expect(THREAD_WRITER_HELD_TEXT).not.toMatch(/serve|寫入者|行程|租約|thread/u);
  });

  it('可寫根接不上：說要回原本的環境、指向管理者，不叫人再試，不提路徑與 serve 的用語（#2222）', () => {
    expect(THREAD_ROOT_MISMATCH_TEXT).toContain('原本的環境');
    expect(THREAD_ROOT_MISMATCH_TEXT).toMatch(/請聯絡管理者。$/u);
    expect(THREAD_ROOT_MISMATCH_TEXT).not.toContain('再試');
    expect(THREAD_ROOT_MISMATCH_TEXT).not.toMatch(/\/|serve|thread/u);
    expect(THREAD_ROOT_MISMATCH_TEXT).not.toContain('home');
    expect(THREAD_ROOT_MISMATCH_TEXT).not.toContain('--workspace');
  });

  it('子代理的會話：指回主對話，不提 thread、wire 或命令名（#1708）', () => {
    expect(THREAD_IS_SUBAGENT_TEXT).toContain('主對話');
    expect(THREAD_IS_SUBAGENT_TEXT).not.toMatch(/thread|subagent|wire/iu);
  });

  it('不是嵌入版開的：叫人按「新對話」，不叫人再試，不提 thread 與嵌入（#2382）', () => {
    expect(THREAD_NOT_EMBEDDED_TEXT).toContain(`「${NEW_CONVERSATION_LABEL}」`);
    expect(THREAD_NOT_EMBEDDED_TEXT).not.toContain('再試');
    expect(THREAD_NOT_EMBEDDED_TEXT).not.toMatch(/thread|embed|嵌入|設定檔/iu);
  });
});
