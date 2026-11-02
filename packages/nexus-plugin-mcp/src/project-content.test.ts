import { describe, expect, it } from 'vitest';
import { CITE_RESOURCE_LINKS, projectNonText } from './project-content.js';

describe('非文字塊換成 dsh 形狀的文字說明', () => {
  it('只有文字：照原樣（回 undefined）', () => {
    expect(projectNonText('純字串')).toBeUndefined();
    expect(
      projectNonText([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBeUndefined();
  });

  it('圖片：MIME 從 data URL 取出，文字塊原樣、順序不變', () => {
    expect(
      projectNonText([
        { type: 'text', text: '前' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
        { type: 'image', source_type: 'base64', data: 'AAAA', mime_type: 'image/png' },
        { type: 'text', text: '後' },
      ]),
    ).toEqual([
      { type: 'text', text: '前' },
      { type: 'text', text: '[image unavailable: image/jpeg; no attachment store is mounted]' },
      { type: 'text', text: '[image unavailable: image/png; no attachment store is mounted]' },
      { type: 'text', text: '後' },
    ]);
  });

  it('音訊、內嵌資源、不認得的類型（沒有 resource link，結尾不加引用提示）', () => {
    expect(
      projectNonText([
        { type: 'audio', source_type: 'base64', data: 'AAAA', mime_type: 'audio/wav' },
        // adapter 2.0.0 的內嵌二進位資源：`data` 加 `metadata: {uri}`，沒有 `url`、沒有 `name`。
        {
          type: 'file',
          data: 'AAAA',
          mimeType: 'application/pdf',
          metadata: { uri: 'file:///a.pdf' },
        },
        { type: 'image_url', image_url: 'https://example.invalid/a.png' },
        { type: 'mystery' },
      ]),
    ).toEqual([
      { type: 'text', text: '[audio result unsupported: audio/wav]' },
      { type: 'text', text: '[embedded resource unsupported]' },
      {
        type: 'text',
        text: '[image unavailable: unknown media type; no attachment store is mounted]',
      },
      { type: 'text', text: '[unsupported MCP content type: mystery]' },
    ]);
  });
});

// adapter 2.0.0 把 `resource_link` 轉成 `file` 塊，`metadata` 帶 `{uri, name, title?}`（`dist/content.js`）。
describe('resource link：dsh 的 `Resource link: <name> (<uri>)`（#1319）', () => {
  const link = (url: string | undefined, name: string | undefined, title?: string) => ({
    type: 'file',
    url,
    mimeType: undefined,
    metadata: { uri: url, name, ...(title === undefined ? {} : { title }) },
  });

  it('有名稱與 URI：寫成 name (uri)，title 不進文字', () => {
    expect(
      projectNonText([
        { type: 'text', text: '查到兩筆。' },
        link('https://wiki.example.test/policy/42', '請假辦法', '員工請假辦法'),
        link('https://bi.example.test/reports/q3', 'Q3 營收報表'),
      ]),
    ).toEqual([
      { type: 'text', text: '查到兩筆。' },
      { type: 'text', text: 'Resource link: 請假辦法 (https://wiki.example.test/policy/42)' },
      { type: 'text', text: 'Resource link: Q3 營收報表 (https://bi.example.test/reports/q3)' },
      { type: 'text', text: CITE_RESOURCE_LINKS },
    ]);
  });

  it('缺名稱或缺 URI：走 dsh 同一句退路，而且不算有連結（不加引用提示）', () => {
    const unavailable = {
      type: 'text',
      text: '[resource link unavailable: the MCP block is missing its name or URI]',
    };
    expect(projectNonText([link('https://x.example.test/a', undefined)])).toEqual([unavailable]);
    expect(projectNonText([link(undefined, '沒有網址')])).toEqual([unavailable]);
  });

  it('混著缺的和好的：好的那條讓結尾有引用提示，壞的仍是退路那句', () => {
    expect(
      projectNonText([link(undefined, '壞的'), link('https://ok.example.test/', '好的')]),
    ).toEqual([
      {
        type: 'text',
        text: '[resource link unavailable: the MCP block is missing its name or URI]',
      },
      { type: 'text', text: 'Resource link: 好的 (https://ok.example.test/)' },
      { type: 'text', text: CITE_RESOURCE_LINKS },
    ]);
  });

  it('引用提示只在最後出現一次，不管有幾條連結；沒有連結的結果不帶', () => {
    const many = projectNonText([
      link('https://a.example.test/', 'a'),
      link('https://b.example.test/', 'b'),
      link('https://c.example.test/', 'c'),
    ]);
    expect(many?.filter((b) => (b as { text?: string }).text === CITE_RESOURCE_LINKS)).toHaveLength(
      1,
    );
    expect(many?.at(-1)).toEqual({ type: 'text', text: CITE_RESOURCE_LINKS });
    expect(
      JSON.stringify(
        projectNonText([{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]),
      ).includes('Cite'),
    ).toBe(false);
  });
});
