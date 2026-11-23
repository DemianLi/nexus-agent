/**
 * 代理政策的共用樣本（#2570）：TS 的 {@link proxyForUrl}、{@link isLoopbackHost} 跑 `native/sandbox-spawner/proxy-vectors.json`，
 * 宿主的 `nexus_host::proxy`（`native/sandbox-spawner/host/tests/proxy.rs`）跑同一份。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { isLoopbackHost, proxyForUrl } from './policy.js';
import type { ProxyPolicy } from './policy.js';

interface Vectors {
  readonly proxyForUrl: readonly {
    readonly name: string;
    readonly policy: {
      readonly httpProxy?: string;
      readonly httpsProxy?: string;
      readonly noProxy: string;
    };
    readonly url: string;
    readonly proxy: string | null;
  }[];
  readonly isLoopbackHost: readonly { readonly host: string; readonly loopback: boolean }[];
}

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../native/sandbox-spawner/proxy-vectors.json', import.meta.url),
    ),
    'utf8',
  ),
) as Vectors;

describe('代理政策的共用樣本', () => {
  it.each(vectors.proxyForUrl.map((v) => [v.name, v] as const))('%s', (_, vector) => {
    const policy: ProxyPolicy = { ...vector.policy, source: 'env' };
    expect(proxyForUrl(policy, new URL(vector.url)) ?? null).toBe(vector.proxy);
  });

  it.each(vectors.isLoopbackHost.map((v) => [v.host, v.loopback] as const))(
    'isLoopbackHost(%s) 是 %s',
    (host, loopback) => {
      expect(isLoopbackHost(host)).toBe(loopback);
    },
  );
});
