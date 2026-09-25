import { describe, expect, it } from 'vitest';
import { projectNonText } from './project-content.js';

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

  it('音訊、resource link、內嵌資源、不認得的類型', () => {
    expect(
      projectNonText([
        { type: 'audio', source_type: 'base64', data: 'AAAA', mime_type: 'audio/wav' },
        { type: 'file', source_type: 'url', url: 'file:///a.txt', mime_type: 'text/plain' },
        { type: 'file', source_type: 'base64', data: 'AAAA', mime_type: 'application/pdf' },
        { type: 'image_url', image_url: 'https://example.invalid/a.png' },
        { type: 'mystery' },
      ]),
    ).toEqual([
      { type: 'text', text: '[audio result unsupported: audio/wav]' },
      { type: 'text', text: 'Resource link: file:///a.txt' },
      { type: 'text', text: '[embedded resource unsupported]' },
      {
        type: 'text',
        text: '[image unavailable: unknown media type; no attachment store is mounted]',
      },
      { type: 'text', text: '[unsupported MCP content type: mystery]' },
    ]);
  });
});
