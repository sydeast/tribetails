import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { applicableNotificationActions, type NotificationRoute } from './notificationActions';
import type { NotificationEntry } from '../api/notifications';

/**
 * #2487: an office or Auntie notice's email button and text message open the
 * same place Open does on this notifications list. The server builds that
 * address itself (mytribe/functions/src/notifications/noticeLink.ts), because
 * an email has no client to ask. These cases are shared with the server's
 * test through one file, so Open and the link cannot drift apart.
 */
interface Case {
  name: string;
  entry: { key: string; targetType: string; targetId: string; data: Record<string, unknown> };
  auntie: boolean;
  path: string | null;
}
const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../mytribe/functions/test/fixtures/officeNoticeRoutes.json',
);
const CASES = (JSON.parse(readFileSync(fixture, 'utf8')) as { cases: Case[] }).cases;

/** A route as the address bar spells it. */
function pathOf(route: NotificationRoute | null): string | null {
  if (route === null) return null;
  let path = route.to;
  for (const [k, v] of Object.entries(route.params ?? {})) path = path.replace(`$${k}`, v);
  const q = new URLSearchParams(route.search ?? {}).toString();
  return q ? `${path}?${q}` : path;
}

describe('Open on the notifications list goes where the notice email links (#2487)', () => {
  it('has the shared cases', () => {
    expect(CASES.length).toBeGreaterThan(10);
  });
  for (const c of CASES) {
    it(c.name, () => {
      const entry = { _id: 'n1', ...c.entry } as NotificationEntry;
      expect(pathOf(applicableNotificationActions(entry, { isAuntie: c.auntie }).open)).toBe(c.path);
    });
  }
});
