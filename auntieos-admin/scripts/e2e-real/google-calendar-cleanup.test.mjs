import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { cleanupE2eCalendarEvents, isE2eSessionId, markerOf, MARKER } from './google-calendar-cleanup.mjs';

/**
 * The cleanup runs with the real test calendar's credentials at the end of
 * every real-services run (#1517). The properties that matter: it deletes
 * only events whose private marker names an e2e session, it is a clean skip
 * without credentials, it refuses the account's own calendar, and a failure
 * is reported without changing the run's exit code.
 */

const ENV = {
  E2E_GOOGLE_OAUTH_CLIENT_ID: 'client.apps.googleusercontent.com',
  E2E_GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-e2e-client-secret',
  E2E_GOOGLE_CALENDAR_REFRESH_TOKEN: '1//0e2e-refresh-token',
  E2E_GOOGLE_CALENDAR_ID: 'abc123@group.calendar.google.com',
};
const NOW = Date.parse('2026-11-04T18:00:00.000Z');

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function event(id, marker) {
  return marker === undefined ? { id } : { id, extendedProperties: { private: { [MARKER]: marker } } };
}

/**
 * A fake Google: a token endpoint, a two-page listing that holds this run's
 * events beside events that must never be touched, and a delete endpoint.
 * [overrides] maps `METHOD path` to a response for failure cases.
 */
function fakeGoogle(overrides = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    const path = u.pathname;
    calls.push({ method, path, url, params: u.searchParams, headers: init?.headers ?? {}, body: init?.body });
    const key = `${method} ${path}`;
    if (overrides[key]) return overrides[key]({ params: u.searchParams, calls, body: init?.body });
    if (key === 'POST /token') return json(200, { access_token: 'ya29.access', expires_in: 3599, token_type: 'Bearer' });
    if (key === 'GET /calendar/v3/calendars/abc123%40group.calendar.google.com/events') {
      if (!u.searchParams.get('pageToken')) {
        return json(200, {
          nextPageToken: 'p2',
          items: [
            event('ev-seed', 'e2e-sess-scheduled'),
            event('ev-spec', 'e2e-real-gcal-visit-abc'),
            // The operator's own entry on the test calendar: no marker.
            event('ev-hand', undefined),
            // Pushed by a production connection with a real session id: not ours.
            event('ev-prod', 'vis_Jk2mN8pQ'),
          ],
        });
      }
      return json(200, { items: [event('ev-booked', 'vis_e2e-real-accept-visit-abc'), event('ev-empty', '')] });
    }
    if (method === 'DELETE' && path.startsWith('/calendar/v3/calendars/abc123%40group.calendar.google.com/events/')) {
      return { ok: true, status: 204, json: async () => { throw new Error('no body'); } };
    }
    return json(404, { error: { message: 'not found' } });
  });
  return { fetchImpl, calls };
}

describe('isE2eSessionId', () => {
  it('admits the three e2e id shapes and nothing else', () => {
    for (const id of ['e2e-sess-today', 'e2e-real-gcal-visit-x1', 'vis_e2e-real-accept-visit-x1']) expect(isE2eSessionId(id), id).toBe(true);
    for (const id of ['', 'vis_Jk2mN8pQ', 'sess-9', 'xe2e-sess', 'E2E-sess', undefined, null, 42]) expect(isE2eSessionId(id), String(id)).toBe(false);
  });
});

describe('markerOf', () => {
  it('reads the private property the push writes, and nothing else', () => {
    expect(markerOf(event('a', 'e2e-sess-today'))).toBe('e2e-sess-today');
    expect(markerOf(event('a', undefined))).toBe('');
    expect(markerOf({ id: 'a', extendedProperties: { shared: { [MARKER]: 'e2e-sess-today' } } })).toBe('');
    expect(markerOf({ id: 'a', extendedProperties: { private: { [MARKER]: 7 } } })).toBe('');
    expect(markerOf(undefined)).toBe('');
  });
});

describe('cleanupE2eCalendarEvents', () => {
  it('skips with the missing variables named, and calls nothing, when credentials are absent', async () => {
    const { fetchImpl } = fakeGoogle();
    const r = await cleanupE2eCalendarEvents({
      env: { E2E_GOOGLE_OAUTH_CLIENT_ID: 'client.apps.googleusercontent.com', E2E_GOOGLE_CALENDAR_ID: '  ' },
      fetchImpl,
      log: () => {},
      now: NOW,
    });
    expect(r.skipped).toBe(true);
    expect(r.missing).toEqual(['E2E_GOOGLE_OAUTH_CLIENT_SECRET', 'E2E_GOOGLE_CALENDAR_REFRESH_TOKEN', 'E2E_GOOGLE_CALENDAR_ID']);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses primary, the account's own calendar, before any request", async () => {
    const { fetchImpl } = fakeGoogle();
    const r = await cleanupE2eCalendarEvents({ env: { ...ENV, E2E_GOOGLE_CALENDAR_ID: 'primary' }, fetchImpl, log: () => {}, now: NOW });
    expect(r.skipped).toBe(false);
    expect(r.errors).toEqual(["E2E_GOOGLE_CALENDAR_ID is primary, the account's own calendar; refusing to list or delete anything on it"]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('deletes only the events whose marker names an e2e session, across every page, and leaves the rest', async () => {
    const { fetchImpl, calls } = fakeGoogle();
    const lines = [];
    const r = await cleanupE2eCalendarEvents({ env: ENV, fetchImpl, log: (l) => lines.push(l), now: NOW });
    expect(r.errors).toEqual([]);
    expect(r.listed).toBe(6);
    expect(r.deleted).toBe(3);
    expect(r.kept).toBe(3);

    // The token exchange: the refresh grant, with the test calendar's token and the OAuth client.
    const token = calls.find((c) => c.path === '/token');
    expect(token.method).toBe('POST');
    const form = new URLSearchParams(String(token.body));
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('1//0e2e-refresh-token');
    expect(form.get('client_id')).toBe('client.apps.googleusercontent.com');
    expect(form.get('client_secret')).toBe('GOCSPX-e2e-client-secret');

    // The listing: the test calendar only, bounded in time, bearer auth, both pages.
    const lists = calls.filter((c) => c.method === 'GET');
    expect(lists.length).toBe(2);
    for (const l of lists) {
      expect(l.path).toBe('/calendar/v3/calendars/abc123%40group.calendar.google.com/events');
      expect(l.headers.Authorization).toBe('Bearer ya29.access');
      expect(l.params.get('singleEvents')).toBe('true');
      expect(Date.parse(l.params.get('timeMin'))).toBeLessThan(NOW);
      expect(Date.parse(l.params.get('timeMax'))).toBeGreaterThan(NOW + 90 * 86_400_000);
    }
    expect(lists[1].params.get('pageToken')).toBe('p2');

    // The deletes: every one names an id the listing produced with an e2e marker.
    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.path.split('/').pop());
    expect(deletes.sort()).toEqual(['ev-booked', 'ev-seed', 'ev-spec']);
    expect(deletes).not.toContain('ev-hand');
    expect(deletes).not.toContain('ev-prod');
    expect(deletes).not.toContain('ev-empty');
    for (const d of calls.filter((c) => c.method === 'DELETE')) expect(d.headers.Authorization).toBe('Bearer ya29.access');

    // Counts only: no id, no token, no event text in the log.
    expect(lines).toEqual(['google-calendar-cleanup: listed 6 events on the test calendar, deleted 3 with an e2e marker, left 3 alone']);
    expect(lines.join('\n')).not.toMatch(/abc123|ya29|1\/\/0e2e/);
  });

  it('counts an event Google already removed as gone, and reports any other failed delete without throwing', async () => {
    const { fetchImpl } = fakeGoogle({
      'DELETE /calendar/v3/calendars/abc123%40group.calendar.google.com/events/ev-seed': () => json(410, { error: { message: 'Resource has been deleted' } }),
      'DELETE /calendar/v3/calendars/abc123%40group.calendar.google.com/events/ev-spec': () => json(403, { error: { message: 'Forbidden' } }),
    });
    const r = await cleanupE2eCalendarEvents({ env: ENV, fetchImpl, log: () => {}, now: NOW });
    expect(r.deleted).toBe(2);
    expect(r.errors).toEqual(['delete event ev-spec: HTTP 403 Forbidden']);
  });

  it('reports a refused token or a failed listing as one error, and deletes nothing', async () => {
    const dead = fakeGoogle({ 'POST /token': () => json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) });
    const r1 = await cleanupE2eCalendarEvents({ env: ENV, fetchImpl: dead.fetchImpl, log: () => {}, now: NOW });
    expect(r1.errors).toEqual(['refresh the access token: HTTP 400 Token has been expired or revoked.']);
    expect(dead.calls.filter((c) => c.method === 'DELETE')).toEqual([]);

    const unlisted = fakeGoogle({
      'GET /calendar/v3/calendars/abc123%40group.calendar.google.com/events': () => json(404, { error: { message: 'Not Found' } }),
    });
    const r2 = await cleanupE2eCalendarEvents({ env: ENV, fetchImpl: unlisted.fetchImpl, log: () => {}, now: NOW });
    expect(r2.errors).toEqual(['list events: HTTP 404 Not Found']);
    expect(r2.deleted).toBe(0);
    expect(unlisted.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });

  it('reports a network failure without throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const r = await cleanupE2eCalendarEvents({ env: ENV, fetchImpl, log: () => {}, now: NOW });
    expect(r.errors).toEqual(['refresh the access token: ECONNRESET']);
  });
});

describe('run.sh on_exit', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  /**
   * run.sh's real `on_exit` (extracted, not copied) under a `node` that
   * behaves as [fakeNode] says. `SECRETS_FILES` is the two-file array run.sh
   * iterates (#1201), each written as preflight.mjs writes it, so a failed
   * cleanup is also checked not to stop the secrets removal after it.
   */
  function runOnExit(exitCode, { fakeNode = null, env = process.env } = {}) {
    const src = readFileSync(join(here, 'run.sh'), 'utf8');
    const fn = src.match(/^on_exit\(\) \{[\s\S]*?^\}$/m)?.[0];
    expect(fn, 'on_exit in run.sh').toBeTruthy();
    const dir = mkdtempSync(join(tmpdir(), 'e2e-real-gcal-onexit-'));
    let path = env.PATH;
    if (fakeNode !== null) {
      const bin = join(dir, 'node');
      writeFileSync(bin, fakeNode);
      chmodSync(bin, 0o755);
      path = `${dir}:${env.PATH}`;
    }
    const secretsFiles = [join(dir, 'mytribe.secret.local'), join(dir, 'admin.secret.local')];
    // First line is preflight.mjs's MARKER, the one on_exit greps for.
    for (const f of secretsFiles) writeFileSync(f, '# written by auntieos-admin/scripts/e2e-real/preflight.mjs (#1089). Deleted at the end of the run.\nX=1\n');
    const script = [
      'set -euo pipefail',
      `SCRIPT_DIR=${JSON.stringify(here)}`,
      `REAL_DIR=${JSON.stringify(dir)}`,
      `VERDICT=${JSON.stringify(join(dir, 'verdict.json'))}`,
      `RESULTS=${JSON.stringify(join(dir, 'results.json'))}`,
      `LOG=${JSON.stringify(join(dir, 'emulators.log'))}`,
      `SECRETS_FILES=(${secretsFiles.map((f) => JSON.stringify(f)).join(' ')})`,
      fn,
      'trap on_exit EXIT',
      `exit ${exitCode}`,
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], { env: { ...env, PATH: path }, encoding: 'utf8' });
    return { ...r, dir, secretsFiles };
  }

  it('runs the calendar cleanup after the Cloudinary one, keeps the run’s exit code when it fails, and still removes both secrets files', () => {
    for (const code of [0, 1, 7]) {
      const r = runOnExit(code, { fakeNode: '#!/bin/sh\necho "fake node $*"\nexit 1\n' });
      expect(r.status, `exit ${code}`).toBe(code);
      expect(r.stderr).toMatch(/Google Calendar cleanup FAILED/);
      expect(r.stdout).toMatch(/fake node .*google-calendar-cleanup\.mjs/);
      expect(r.stdout.indexOf('cloudinary-cleanup.mjs')).toBeLessThan(r.stdout.indexOf('google-calendar-cleanup.mjs'));
      expect(r.secretsFiles.map((f) => existsSync(f)), `exit ${code}`).toEqual([false, false]);
    }
  });

  it('skips cleanly, naming the four variables, when the run had no calendar credentials', () => {
    const bare = { PATH: process.env.PATH, HOME: process.env.HOME };
    const r = runOnExit(0, { env: bare });
    expect(r.status).toBe(0);
    expect(r.secretsFiles.map((f) => existsSync(f))).toEqual([false, false]);
    expect(r.stdout).toMatch(
      /google-calendar-cleanup: skipped, E2E_GOOGLE_OAUTH_CLIENT_ID, E2E_GOOGLE_OAUTH_CLIENT_SECRET, E2E_GOOGLE_CALENDAR_REFRESH_TOKEN, E2E_GOOGLE_CALENDAR_ID not set/,
    );
    expect(r.stderr).not.toMatch(/Google Calendar cleanup FAILED/);
  });
});
