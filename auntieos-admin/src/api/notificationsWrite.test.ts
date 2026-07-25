import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { archiveNotification, bulkArchiveNotifications } from './notificationsWrite';

beforeEach(() => call.mockReset());

describe('archiveNotification', () => {
  it('sends exactly { id }, the backend ArchiveArgs key (NOT notificationId)', async () => {
    call.mockResolvedValue({ archived: 1 });
    await archiveNotification('n1');
    expect(call).toHaveBeenCalledWith('archiveNotification', { id: 'n1' });
  });

  it('returns how many were archived, which can be 0 for a row the caller may not touch', async () => {
    call.mockResolvedValue({ archived: 0 });
    await expect(archiveNotification('n1')).resolves.toBe(0);
  });

  it('propagates a rejection rather than swallowing it (fail-loud)', async () => {
    call.mockRejectedValueOnce(new Error('permission-denied'));
    await expect(archiveNotification('n1')).rejects.toThrow('permission-denied');
  });
});

describe('bulkArchiveNotifications', () => {
  it('sends exactly { ids }', async () => {
    call.mockResolvedValue({ archived: 2 });
    await bulkArchiveNotifications(['a', 'b']);
    expect(call).toHaveBeenCalledWith('bulkArchiveNotifications', { ids: ['a', 'b'] });
  });

  it('returns the real archived count, which can be smaller than the request', async () => {
    call.mockResolvedValue({ archived: 1 });
    await expect(bulkArchiveNotifications(['a', 'b'])).resolves.toBe(1);
  });

  it('propagates a rejection rather than swallowing it (fail-loud)', async () => {
    call.mockRejectedValueOnce(new Error('unauthenticated'));
    await expect(bulkArchiveNotifications(['a'])).rejects.toThrow('unauthenticated');
  });
});
