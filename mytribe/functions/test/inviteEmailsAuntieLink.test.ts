import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mocks = vi.hoisted(() => ({
  sendFromTemplate: vi.fn().mockResolvedValue('msg-1'),
  loadEmailFrame: vi.fn().mockResolvedValue(null),
}));
vi.mock('../src/lib/sendFromTemplate', () => ({ sendFromTemplate: mocks.sendFromTemplate }));
vi.mock('../src/lib/emailFrameStore', () => ({ loadEmailFrame: mocks.loadEmailFrame }));

import { sendPrimaryInviteEmails } from '../src/lib/inviteEmails';

/**
 * #1339: the `invite.auntie-notify` link must land on a route the admin web app
 * actually has. The admin router serves `invites/$inviteId` at the root of the
 * admin origin (no base path), so `AUNTIE_OS_REVIEW_BASE_URL` is that origin and
 * the link is `<origin>/invites/<inviteId>`.
 */
const ROUTER = resolve(__dirname, '../../../auntieos-admin/src/router.tsx');

beforeEach(() => {
  mocks.sendFromTemplate.mockClear();
});

async function auntieLinkFor(inviteId: string, reviewBaseUrl: string): Promise<string> {
  await sendPrimaryInviteEmails({
    inviteId,
    invitedEmail: 'jane@example.com',
    secondaryLabel: 'Sister',
    tribeName: 'f1',
    claimBaseUrl: 'https://claim.example',
    expiresInDays: 7,
    proposedPermissions: { messaging_direct: true },
    authorName: 'Dora',
    primaryEmail: null,
    auntieNotify: { email: 'notify@example.com', reviewBaseUrl },
  });
  const call = mocks.sendFromTemplate.mock.calls.find((c) => c[0] === 'invite.auntie-notify');
  expect(call).toBeDefined();
  return (call![2] as { auntieReviewUrl: string }).auntieReviewUrl;
}

describe('invite.auntie-notify link (#1339)', () => {
  it('builds <admin origin>/invites/<inviteId>', async () => {
    expect(await auntieLinkFor('inv123', 'https://admin.example')).toBe('https://admin.example/invites/inv123');
  });

  it('the admin web router has the route the link points at, at the root of the admin layout', () => {
    const router = readFileSync(ROUTER, 'utf8');
    // The detail route the link opens.
    expect(router).toMatch(/path:\s*'invites\/\$inviteId'/);
    // And the admin layout is path-less, so `/invites/<id>` is the full path:
    // an operator sets AUNTIE_OS_REVIEW_BASE_URL to the bare admin origin.
    expect(router).toMatch(/const adminRoute = createRoute\(\{\s*getParentRoute: \(\) => rootRoute,\s*id: 'admin',/);
  });
});
