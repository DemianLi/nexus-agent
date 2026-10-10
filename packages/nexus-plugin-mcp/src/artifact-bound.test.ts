import { describe, expect, it } from 'vitest';
import { ARTIFACT_ENTRY_MAX_BYTES, boundArtifacts } from './artifact-bound.js';

const big = (n = ARTIFACT_ENTRY_MAX_BYTES) => 'A'.repeat(n);

describe('artifact 進日誌前的上限（#1320）', () => {
  it('沒有 artifact、或全部在上限內：照原樣（回 undefined）', () => {
    expect(boundArtifacts(undefined)).toBeUndefined();
    expect(boundArtifacts([])).toBeUndefined();
    expect(
      boundArtifacts([
        { type: 'mcp_content', data: { type: 'resource_link', uri: 'https://a/1', name: 'a' } },
        { type: 'mcp_meta', data: { trace: 'x' } },
      ]),
    ).toBeUndefined();
  });

  it('內嵌資源超過上限：換成占位，留型別、大小、URI 與 MIME，資料不留', () => {
    const resource = {
      type: 'resource',
      resource: {
        uri: 'file:///reports/q3.bin',
        mimeType: 'application/octet-stream',
        blob: big(),
      },
    };
    const [placeholder] = boundArtifacts([resource]) ?? [];
    expect(placeholder).toEqual({
      type: 'mcp_omitted',
      originalType: 'resource',
      bytes: Buffer.byteLength(JSON.stringify(resource)),
      uri: 'file:///reports/q3.bin',
      mimeType: 'application/octet-stream',
    });
    expect(JSON.stringify(placeholder)).not.toContain('AAAA');
  });

  it('structuredContent 超過上限：占位帶型別與大小', () => {
    const entry = { type: 'mcp_structured_content', data: { rows: [big()] } };
    const [placeholder] = boundArtifacts([entry]) ?? [];
    expect(placeholder).toMatchObject({
      type: 'mcp_omitted',
      originalType: 'mcp_structured_content',
    });
    expect(JSON.stringify(placeholder)).not.toContain('AAAA');
  });

  // adapter 2.0.0 `convertCallToolResult`：`enhancedArtifacts` 把內嵌資源原始區塊整個放進 `data`，所以 URI 在 `data.resource` 底下。
  it('adapter 的 `mcp_content` 包著內嵌資源時，URI 與 MIME 從 data.resource 取', () => {
    const entry = {
      type: 'mcp_content',
      data: {
        type: 'resource',
        resource: { uri: 'file:///x', mimeType: 'text/plain', text: big() },
      },
    };
    expect(boundArtifacts([entry])?.[0]).toMatchObject({
      type: 'mcp_omitted',
      originalType: 'mcp_content',
      uri: 'file:///x',
      mimeType: 'text/plain',
    });
  });

  it('`mcp_content` 包著超大的 resource_link 區塊：URI 在 data 頂層', () => {
    const entry = {
      type: 'mcp_content',
      data: { type: 'resource_link', uri: 'https://a/big', mimeType: 'text/csv', name: big() },
    };
    expect(boundArtifacts([entry])?.[0]).toMatchObject({
      uri: 'https://a/big',
      mimeType: 'text/csv',
    });
  });

  it('找不到 URI 時占位不帶 uri 與 mimeType', () => {
    const [placeholder] = boundArtifacts([{ type: 'mcp_meta', data: { note: big() } }]) ?? [];
    expect(placeholder).not.toHaveProperty('uri');
    expect(placeholder).not.toHaveProperty('mimeType');
  });

  it('剛好在上限：保留；多一位元組：換掉', () => {
    const fits = (n: number) => {
      const base = JSON.stringify({ type: 'mcp_meta', data: '' });
      return { type: 'mcp_meta', data: 'a'.repeat(n - Buffer.byteLength(base)) };
    };
    expect(boundArtifacts([fits(ARTIFACT_ENTRY_MAX_BYTES)])).toBeUndefined();
    expect(boundArtifacts([fits(ARTIFACT_ENTRY_MAX_BYTES + 1)])?.[0]).toMatchObject({
      type: 'mcp_omitted',
    });
  });

  it('大小以序列化後的位元組算，不是字元數（中文每字三位元組）', () => {
    const entry = { type: 'mcp_meta', data: '中'.repeat(Math.ceil(ARTIFACT_ENTRY_MAX_BYTES / 3)) };
    expect(boundArtifacts([entry])?.[0]).toMatchObject({ type: 'mcp_omitted' });
  });

  it('逐條判斷：大的換掉，小的原樣，順序不變', () => {
    const small = { type: 'mcp_content', data: { type: 'resource_link', uri: 'https://a/1' } };
    const bigOne = { type: 'resource', resource: { uri: 'file:///b', blob: big() } };
    const out = boundArtifacts([small, bigOne, small]);
    expect(out?.[0]).toBe(small);
    expect(out?.[1]).toMatchObject({ type: 'mcp_omitted', uri: 'file:///b' });
    expect(out?.[2]).toBe(small);
  });

  it('序列化不了的東西（循環）：當作超限換掉，不拋', () => {
    const loop: Record<string, unknown> = { type: 'mcp_meta' };
    loop['self'] = loop;
    expect(boundArtifacts([loop])?.[0]).toMatchObject({ originalType: 'mcp_meta', bytes: -1 });
  });

  it('不是物件的 artifact：型別記 unknown', () => {
    expect(boundArtifacts([big(ARTIFACT_ENTRY_MAX_BYTES + 10)])?.[0]).toMatchObject({
      type: 'mcp_omitted',
      originalType: 'unknown',
    });
  });
});
