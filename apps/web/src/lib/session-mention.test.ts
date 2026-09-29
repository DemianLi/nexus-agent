import { formatSessionReferenceMention } from '@nexus/wire';
import type { SessionReferenceCandidate } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { detectMention } from '@/lib/file-mention';
import {
  applySessionPick,
  mentionDisplayText,
  referenceSegments,
  sessionRows,
} from '@/lib/session-mention';

/** `@` 引用別的會話（#713）在畫面上的規則。編碼與候選的形狀是 `@nexus/wire` 的，這裡驗畫面怎麼用它。 */

function candidate(
  sessionId: string,
  extra: Partial<SessionReferenceCandidate> = {},
): SessionReferenceCandidate {
  const label = extra.label ?? sessionId;
  return {
    sessionId,
    label,
    sameWorkspace: true,
    createdAt: 1,
    updatedAt: 2,
    mention: formatSessionReferenceMention({ sessionId, label }),
    ...extra,
  };
}

describe('選單的列', () => {
  it('同專案的主會話只寫標題', () => {
    expect(sessionRows([candidate('a', { label: '昨天那條', cwd: '/w/nexus' })])).toEqual([
      expect.objectContaining({ source: 'session', name: '昨天那條' }),
    ]);
    expect(sessionRows([candidate('a', { cwd: '/w/nexus' })])[0]).not.toHaveProperty('hint');
  });

  it('別的專案後面加目錄名（Q4）', () => {
    const [row] = sessionRows([
      candidate('b', { label: '報表', sameWorkspace: false, cwd: '/Users/x/Projects/reports/' }),
    ]);
    expect(row).toMatchObject({ source: 'session', name: '報表', hint: 'reports' });
  });

  it('別的專案但沒有記錄目錄：不寫', () => {
    const [row] = sessionRows([candidate('b', { sameWorkspace: false })]);
    expect(row).not.toHaveProperty('hint');
  });

  it('子代理寫它屬於哪條會話，用標題不畫 id', () => {
    const [row] = sessionRows([
      candidate('sub-1', { label: '查資料', parentSessionId: 'root-1', parentLabel: '大會話' }),
    ]);
    expect(row).toMatchObject({ source: 'subagent', name: '查資料', hint: '屬於 大會話' });
  });

  it('子代理的母會話讀不到標題時，wire 給的就是它的 id：照寫', () => {
    const [row] = sessionRows([
      candidate('sub-1', { parentSessionId: 'root-1', parentLabel: 'root-1' }),
    ]);
    expect(row).toMatchObject({ source: 'subagent', hint: '屬於 root-1' });
  });

  it('照伺服器給的先後，不重排', () => {
    expect(
      sessionRows([candidate('z'), candidate('a')]).map((row) => row.candidate.sessionId),
    ).toEqual(['z', 'a']);
  });
});

describe('選了之後', () => {
  it('@ 那一段換成伺服器編好的引用文字，補一個空白，游標在後面', () => {
    const draft = '照 @昨 的方案改';
    const hit = detectMention(draft, 4)!;
    const picked = candidate('s1', { label: '昨天那條' });
    const result = applySessionPick(draft, hit, picked);
    expect(result.draft).toBe(`照 ${picked.mention}  的方案改`);
    expect(result.caret).toBe(`照 ${picked.mention} `.length);
  });

  it('標題裡有 ] 與 \\ 的照伺服器編好的原樣插（不自己改寫）', () => {
    const picked = candidate('s2', { label: 'a]b\\c' });
    const hit = detectMention('@', 1)!;
    expect(applySessionPick('@', hit, picked).draft).toBe(`${picked.mention} `);
    expect(picked.mention).toContain('a\\]b\\\\c');
  });

  it('選好的引用整段貼著游標時不算在打 @（退格退掉空白之後）', () => {
    const mention = candidate('s1', { label: '昨天那條' }).mention;
    expect(detectMention(mention, mention.length)).toBeNull();
    expect(detectMention(`先看 ${mention}`, `先看 ${mention}`.length)).toBeNull();
    // 只是 @ 加一段字還是照常。
    expect(detectMention('先看 @昨', 5)).not.toBeNull();
  });
});

describe('顯示用的文字', () => {
  it('引用換成 @標題', () => {
    const { mention } = candidate('s1', { label: '昨天那條' });
    expect(mentionDisplayText(`照 ${mention} 的方案改`)).toBe('照 @昨天那條 的方案改');
  });

  it('沒有引用的原樣', () => {
    expect(mentionDisplayText('user@host 說 nexus-session 不對')).toBe(
      'user@host 說 nexus-session 不對',
    );
  });

  it('網址壞了就照原文畫，不拋', () => {
    const bad = '看 @[x](nexus-session:@@@)';
    expect(mentionDisplayText(bad)).toBe(bad);
  });
});

describe('切開被領走的人話', () => {
  const ref = (sessionId: string, label: string) => ({ sessionId, label });

  it('沒有引用就一整段', () => {
    expect(referenceSegments('你好', undefined)).toEqual([{ kind: 'text', text: '你好' }]);
    expect(referenceSegments('你好', [])).toEqual([{ kind: 'text', text: '你好' }]);
  });

  it('引用切成一塊，前後的字保留', () => {
    expect(referenceSegments('照 @昨天那條 的方案改', [ref('s1', '昨天那條')])).toEqual([
      { kind: 'text', text: '照 ' },
      { kind: 'reference', text: '@昨天那條', reference: ref('s1', '昨天那條') },
      { kind: 'text', text: ' 的方案改' },
    ]);
  });

  it('同一個標題出現兩次就切兩塊（references 已去重）', () => {
    const segments = referenceSegments('@甲 和 @甲', [ref('a', '甲')]);
    expect(segments.filter((segment) => segment.kind === 'reference')).toHaveLength(2);
  });

  it('兩條不同的會話，照各自的標題對上', () => {
    const segments = referenceSegments('@甲 @乙', [ref('a', '甲'), ref('b', '乙')]);
    expect(
      segments.flatMap((segment) =>
        segment.kind === 'reference' ? [segment.reference.sessionId] : [],
      ),
    ).toEqual(['a', 'b']);
  });

  it('一個標題是另一個的開頭：長的先比', () => {
    const segments = referenceSegments('@foo bar 與 @foo', [
      ref('long', 'foo bar'),
      ref('short', 'foo'),
    ]);
    expect(segments.map((segment) => segment.text)).toEqual(['@foo bar', ' 與 ', '@foo']);
    expect(segments[0]).toMatchObject({ kind: 'reference', reference: { sessionId: 'long' } });
    expect(segments[2]).toMatchObject({ kind: 'reference', reference: { sessionId: 'short' } });
  });

  it('標題裡有正規式的特殊字元也照字面比', () => {
    const segments = referenceSegments('看 @a.b(c)+ 吧', [ref('x', 'a.b(c)+')]);
    expect(segments[1]).toMatchObject({ kind: 'reference', text: '@a.b(c)+' });
    expect(referenceSegments('看 @aXb(c)+ 吧', [ref('x', 'a.b(c)+')])).toEqual([
      { kind: 'text', text: '看 @aXb(c)+ 吧' },
    ]);
  });

  it('文字裡找不到（標題被改了、或畫的是別的）就整段一般文字', () => {
    expect(referenceSegments('沒有引用', [ref('s', '甲')])).toEqual([
      { kind: 'text', text: '沒有引用' },
    ]);
  });
});
