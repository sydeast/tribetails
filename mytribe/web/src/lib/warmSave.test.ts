import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1504: the warm call itself. `test-setup.ts` replaces `warmSave` with a spy
 * for every other spec; this one tests the real module.
 */
vi.unmock('./warmSave');
vi.mock('./fns', () => ({ call: vi.fn() }));

import { call } from './fns';
import { WARMABLE_SAVES, WARM_PAYLOAD, warmSave } from './warmSave';

beforeEach(() => {
  vi.mocked(call).mockReset();
});

describe('warmSave', () => {
  it('sends exactly the warm marker as a background call', async () => {
    vi.mocked(call).mockResolvedValue({ ok: true, warm: true });
    await warmSave('saveMyAccount');
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('saveMyAccount', { __warm: true }, { background: true });
  });

  it('sends a fresh object each time, so nothing can mutate the shared marker', async () => {
    vi.mocked(call).mockResolvedValue({});
    await warmSave('addKin');
    const sent = vi.mocked(call).mock.calls[0]![1];
    expect(sent).toEqual(WARM_PAYLOAD);
    expect(sent).not.toBe(WARM_PAYLOAD);
    expect(Object.isFrozen(WARM_PAYLOAD)).toBe(true);
  });

  it('never rejects: a failure is logged and dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cold = new Error('UNAVAILABLE: cold start');
    vi.mocked(call).mockRejectedValue(cold);
    await expect(warmSave('requestBooking')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('requestBooking warm call failed');
    expect(warn.mock.calls[0]![1]).toBe(cold);
    warn.mockRestore();
  });

  it('warms the same saves as the portal Android app', () => {
    // Read off the Kotlin enum so the two clients cannot drift apart.
    const kotlin = readFileSync(
      resolve(__dirname, '../../../src/commonMain/kotlin/com/kinfolk/portal/portal/WarmOnOpen.kt'),
      'utf8',
    );
    const androidNames = [...kotlin.matchAll(/^\s+[A-Z][A-Za-z]+\("([A-Za-z]+)"\),$/gm)].map((m) => m[1]);
    expect(androidNames).toEqual([...WARMABLE_SAVES]);
  });

  it('names only callables that route through wrapCallable, where the warm short circuit lives', () => {
    const src = resolve(__dirname, '../../../functions/src');
    const sources = ['portal/account.ts', 'portal/saveTribeProfile.ts', 'portal/saveHomeAccess.ts',
      'portal/notificationPrefs.ts', 'portal/addBookingNote.ts', 'portal/requestBooking.ts', 'portal/kinWrites.ts',
      'share/createShareLink.ts', 'portal/generate.ts', 'portal/sendKinfolkMessage.ts']
      .map((f) => readFileSync(resolve(src, f), 'utf8'))
      .join('\n');
    for (const name of WARMABLE_SAVES) {
      expect(sources, name).toContain(`wrapCallable('${name}',`);
    }
  });
});
