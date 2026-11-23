/**
 * 換票（`embed-login.ts`）與兌換（`embed-session.ts`）共用的回應與本文讀法（[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)）。
 * 回應一律帶 `cache-control: no-store`。
 *
 * @module
 */

/** JSON 回應。 */
export function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      ...extra,
    },
  });
}

/** 純文字回應。 */
export function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', ...extra },
  });
}

/** 本文不對的原因，原樣回給對方、寫進稽核。 */
export type BodyRejection =
  'content_type' | 'body_encoding' | 'body_too_large' | 'body_json' | 'body_shape';

/** 讀本文，超過上限回 `undefined`。 */
async function readLimitedBody(request: Request, maxBytes: number): Promise<string | undefined> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) return undefined;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) return undefined;
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * 讀一個 JSON 物件本文：`Content-Type` 要是 `application/json`、不超過 `maxBytes`、是合法的 UTF-8 與 JSON、頂層是物件。
 * 欄位由呼叫端驗。
 */
export async function readJsonObject(
  request: Request,
  maxBytes: number,
): Promise<
  | { readonly ok: true; readonly record: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: BodyRejection }
> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/json(\s*;|$)/iu.test(contentType)) {
    return { ok: false, reason: 'content_type' };
  }
  let text: string | undefined;
  try {
    text = await readLimitedBody(request, maxBytes);
  } catch {
    // 不是 UTF-8，或本文讀到一半失敗（對方斷線）。
    return { ok: false, reason: 'body_encoding' };
  }
  if (text === undefined) return { ok: false, reason: 'body_too_large' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'body_json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'body_shape' };
  }
  return { ok: true, record: parsed as Record<string, unknown> };
}
