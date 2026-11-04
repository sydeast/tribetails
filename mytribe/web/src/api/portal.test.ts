import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call } from '../lib/fns';
import { addKin, canDeleteKin, confirmSecureReset, deleteKin, requestKinRemoval, updateKin } from './portal';

// Replace the single callables choke point so the test asserts the exact
// payload the wrapper builds, without touching the network.
vi.mock('../lib/fns', () => ({ call: vi.fn() }));

describe('addKin wrapper', () => {
  beforeEach(() => {
    vi.mocked(call).mockReset();
    vi.mocked(call).mockResolvedValue({ kinId: 'new-1' } as never);
  });

  it('omits kinfolkId when not provided, and forwards the full kin payload', async () => {
    await addKin({ name: 'Rex', species: 'Dog' });
    expect(call).toHaveBeenCalledWith('addKin', { kin: { name: 'Rex', species: 'Dog' } });
  });

  it('includes kinfolkId only when provided', async () => {
    await addKin({ name: 'Rex' }, 'fam1');
    expect(call).toHaveBeenCalledWith('addKin', { kin: { name: 'Rex' }, kinfolkId: 'fam1' });
  });

  it('returns the callable result (the new kinId)', async () => {
    await expect(addKin({ name: 'Rex' })).resolves.toEqual({ kinId: 'new-1' });
  });

  it('does not swallow a rejection (fail loud)', async () => {
    vi.mocked(call).mockRejectedValueOnce(new Error('permission-denied'));
    await expect(addKin({ name: 'Rex' }, 'fam1')).rejects.toThrow('permission-denied');
  });
});

describe('deleteKin wrappers (#1314)', () => {
  beforeEach(() => {
    vi.mocked(call).mockReset();
    vi.mocked(call).mockResolvedValue({ ok: true, deleted: false, canDelete: true, blockedBy: [] } as never);
  });

  it('canDeleteKin calls deleteKin WITHOUT confirm, so it is a read', async () => {
    await canDeleteKin('k1', 'fam1');
    expect(call).toHaveBeenCalledWith('deleteKin', { kinId: 'k1', kinfolkId: 'fam1' });
    await canDeleteKin('k1');
    expect(call).toHaveBeenLastCalledWith('deleteKin', { kinId: 'k1' });
  });

  it('deleteKin sends confirm: true and the optional kinfolkId', async () => {
    await deleteKin('k1', 'fam1');
    expect(call).toHaveBeenCalledWith('deleteKin', { kinId: 'k1', confirm: true, kinfolkId: 'fam1' });
    await deleteKin('k1');
    expect(call).toHaveBeenLastCalledWith('deleteKin', { kinId: 'k1', confirm: true });
  });

  it('does not swallow a refusal (fail loud)', async () => {
    vi.mocked(call).mockRejectedValueOnce(new Error('Buddy has visits on file, so this profile cannot be deleted from here.'));
    await expect(deleteKin('k1', 'fam1')).rejects.toThrow('cannot be deleted from here');
  });
});

describe('requestKinRemoval wrapper (#1408)', () => {
  beforeEach(() => {
    vi.mocked(call).mockReset();
    vi.mocked(call).mockResolvedValue({ ok: true, removalRequest: { id: 'fam1_k1', status: 'pending' } } as never);
  });

  it('sends the trimmed reason and the optional kinfolkId', async () => {
    await requestKinRemoval('k1', '  Rehomed with my sister  ', 'fam1');
    expect(call).toHaveBeenCalledWith('requestKinRemoval', { kinId: 'k1', reason: 'Rehomed with my sister', kinfolkId: 'fam1' });
  });

  it('omits a blank reason and an absent kinfolkId', async () => {
    await requestKinRemoval('k1', '   ');
    expect(call).toHaveBeenLastCalledWith('requestKinRemoval', { kinId: 'k1' });
  });

  it('does not swallow a refusal (fail loud)', async () => {
    vi.mocked(call).mockRejectedValueOnce(new Error('Removal of Buddy has already been requested.'));
    await expect(requestKinRemoval('k1', '', 'fam1')).rejects.toThrow('already been requested');
  });
});

describe('updateKin wrapper', () => {
  beforeEach(() => {
    vi.mocked(call).mockReset();
    vi.mocked(call).mockResolvedValue({ ok: true } as never);
  });

  it('omits kinfolkId when it is not provided (matches the archiveKin optional shape)', async () => {
    await updateKin('k1', { name: 'Rex' });
    expect(call).toHaveBeenCalledWith('updateKin', { kinId: 'k1', kin: { name: 'Rex' } });
  });

  it('includes kinfolkId only when provided, and forwards the partial verbatim', async () => {
    await updateKin('k1', { name: 'Rex', species: null }, 'fam1');
    expect(call).toHaveBeenCalledWith('updateKin', { kinId: 'k1', kin: { name: 'Rex', species: null }, kinfolkId: 'fam1' });
  });

  it('returns the callable result', async () => {
    await expect(updateKin('k1', {})).resolves.toEqual({ ok: true });
    expect(call).toHaveBeenCalledWith('updateKin', { kinId: 'k1', kin: {} });
  });
});

// confirmSecureReset is an onRequest endpoint, not a callable: it bypasses
// `call` and hits fetch directly, so the stub is on fetch. Each case asserts
// the exact sentence the screen renders (SecureReset.tsx shows err.message).
describe('confirmSecureReset failure messages (#1544)', () => {
  const RETRY = "Securing accounts isn't available right now. Try again in a few minutes.";
  const BAD_LINK = 'Could not secure your account. The reset link may have expired.';
  const req = { oobCode: 'code-1', newPassword: 'longenough1' } as never;
  function answer(status: number, body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })),
    );
  }
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('a 503 auth_unavailable (#1542, the verify body never arrived) says try again, matching Android and desktop', async () => {
    answer(503, { error: 'auth_unavailable', retryable: true, code: 'UND_ERR_BODY_TIMEOUT', detail: 'x' });
    await expect(confirmSecureReset(req)).rejects.toThrow(RETRY);
  });
  it('retryable: true on any other failing status also says try again', async () => {
    answer(500, { error: 'auth_unavailable', retryable: true });
    await expect(confirmSecureReset(req)).rejects.toThrow(RETRY);
  });
  it('a 429 keeps the daily-limit message', async () => {
    answer(429, { error: 'rate_limited', retryable: true });
    await expect(confirmSecureReset(req)).rejects.toThrow('Too many attempts for this account today. Try again tomorrow.');
  });
  it('a 400 reset_failed keeps the bad-link message', async () => {
    answer(400, { error: 'reset_failed', detail: 'no_account_for_code' });
    await expect(confirmSecureReset(req)).rejects.toThrow(BAD_LINK);
  });
  it('a 200 with ok: true returns the body', async () => {
    answer(200, { ok: true, incidentId: 'inc-1' });
    await expect(confirmSecureReset(req)).resolves.toEqual({ ok: true, incidentId: 'inc-1' });
  });
});
