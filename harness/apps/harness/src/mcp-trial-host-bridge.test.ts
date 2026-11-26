import { HostCallError } from '@nexus/host-bridge';
import { HostMcpClient } from '@nexus/plugin-mcp';
import { describe, expect, it } from 'vitest';

import { TRIAL_HOST_BRIDGE } from './mcp-trial-host-bridge.js';

describe('試組用的宿主門面', () => {
  it('mcp/client 的 open 當場 ready、清單是空的，不等任何連線', async () => {
    const started = Date.now();
    const client = await HostMcpClient.open(TRIAL_HOST_BRIDGE, {
      server: { serverName: 'crm' },
      elicitation: false,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await client.listTools()).toEqual({ tools: [] });
    await client.close();
  });

  it('其他服務一律當宿主不在', async () => {
    const failure = await TRIAL_HOST_BRIDGE.call('other', 'm', null).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(HostCallError);
    expect((failure as HostCallError).code).toBe('host_absent');
  });
});
