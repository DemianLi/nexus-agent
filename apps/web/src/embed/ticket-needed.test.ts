import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { TICKET_RENEW_LEAD_MS, TicketWatch } from './ticket-needed';
import type { NexusTicketNeededDetail } from './ticket-needed';

describe('TicketWatch（#2370）', () => {
  let seen: NexusTicketNeededDetail[];
  let watch: TicketWatch;

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    seen = [];
    watch = new TicketWatch(
      (detail) => seen.push(detail),
      () => Date.now(),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('到期前一分鐘發 expiring，帶到期時間；只發一次', () => {
    watch.resume();
    const expiresAt = Date.now() + 900_000;
    watch.signedIn(expiresAt);
    vi.advanceTimersByTime(900_000 - TICKET_RENEW_LEAD_MS - 1);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([{ reason: 'expiring', expiresAt }]);
    watch.unauthorized();
    vi.advanceTimersByTime(900_000);
    expect(seen).toHaveLength(1);
  });

  test('401 發 unauthorized；同一輪不再發 expiring，下一次 signIn 重來', () => {
    watch.resume();
    watch.signedIn(Date.now() + 900_000);
    watch.unauthorized();
    watch.unauthorized();
    vi.advanceTimersByTime(900_000);
    expect(seen).toEqual([{ reason: 'unauthorized' }]);
    watch.signedIn(Date.now() + 900_000);
    watch.unauthorized();
    expect(seen).toEqual([{ reason: 'unauthorized' }, { reason: 'unauthorized' }]);
  });

  test('還沒換過票也會因為 401 發一次', () => {
    watch.resume();
    watch.unauthorized();
    expect(seen).toEqual([{ reason: 'unauthorized' }]);
  });

  test('拿掉時不計時；放回去照當下重算，已經過了提前的那一刻就馬上發', () => {
    const expiresAt = Date.now() + 900_000;
    watch.signedIn(expiresAt);
    vi.advanceTimersByTime(900_000);
    expect(seen).toEqual([]);
    watch.resume();
    vi.advanceTimersByTime(0);
    expect(seen).toEqual([{ reason: 'expiring', expiresAt }]);
  });

  test('pause 之後到點不發', () => {
    watch.resume();
    watch.signedIn(Date.now() + 900_000);
    watch.pause();
    vi.advanceTimersByTime(900_000);
    expect(seen).toEqual([]);
  });

  test('到期時間超過 setTimeout 收得下的上限：不會馬上發', () => {
    watch.resume();
    const expiresAt = Date.now() + 40 * 24 * 3_600_000;
    watch.signedIn(expiresAt);
    vi.advanceTimersByTime(30 * 24 * 3_600_000);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(10 * 24 * 3_600_000);
    expect(seen).toEqual([{ reason: 'expiring', expiresAt }]);
  });
});
