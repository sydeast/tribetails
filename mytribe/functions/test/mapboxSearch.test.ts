import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';

vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { mapboxSearchHandler, mapboxRetrieveHandler } from '../src/portal/mapboxSearch';

function req<T>(data: T, uid: string | null = 'kin-1'): CallableRequest<T> {
  return { data, auth: uid ? ({ uid, token: {} } as any) : undefined } as unknown as CallableRequest<T>;
}

/** Captures the URL the handler builds and answers with a canned upstream body. */
function captureFetch(body: unknown, ok = true, status = 200) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(String(url));
    return { ok, status, json: async () => body };
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

/** The `access_token` the handler actually put on the wire, decoded. */
function sentToken(url: string): string | null {
  return new URL(url).searchParams.get('access_token');
}

const SAVED = process.env.MAPBOX_ACCESS_TOKEN;

beforeEach(() => {
  process.env.MAPBOX_ACCESS_TOKEN = 'pk.a-real-token';
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (SAVED === undefined) delete process.env.MAPBOX_ACCESS_TOKEN;
  else process.env.MAPBOX_ACCESS_TOKEN = SAVED;
});

// ---------------------------------------------------------------------------
// MYTRIBE-FUNCTIONS-D. `gcloud secrets versions add --data-file=-` fed by `echo`
// stores a trailing newline, and Secret Manager returns the bytes as stored. A
// newline survives `URLSearchParams` as `%0A`, so Mapbox is handed a token it
// has never issued and answers 401 on a credential that is otherwise valid
// and that four other readers in this codebase, all of which trim, use happily.
// These assert on the outgoing token rather than on a 200, because the handler
// returns 200 either way when the upstream is stubbed; the newline is only
// visible in what went out.
// ---------------------------------------------------------------------------
describe('the secret is trimmed before it reaches Mapbox', () => {
  it('mapboxSearch strips a trailing newline from the stored secret', async () => {
    process.env.MAPBOX_ACCESS_TOKEN = 'pk.a-real-token\n';
    const calls = captureFetch({ suggestions: [] });

    await mapboxSearchHandler(req({ query: 'l2 Main St', sessionToken: 'sess-abcdef01' }));

    expect(calls).toHaveLength(1);
    expect(sentToken(calls[0])).toBe('pk.a-real-token');
    expect(calls[0]).not.toContain('%0A');
  });

  it('mapboxRetrieve strips a trailing newline from the stored secret', async () => {
    process.env.MAPBOX_ACCESS_TOKEN = 'pk.a-real-token\n';
    const calls = captureFetch({ features: [] });

    await mapboxRetrieveHandler(req({ mapboxId: 'dXJuOm1ieA', sessionToken: 'sess-abcdef01' }));

    expect(calls).toHaveLength(1);
    expect(sentToken(calls[0])).toBe('pk.a-real-token');
    expect(calls[0]).not.toContain('%0A');
  });

  it('strips surrounding whitespace of any shape, not just a newline', async () => {
    process.env.MAPBOX_ACCESS_TOKEN = '  pk.a-real-token\r\n';
    const calls = captureFetch({ suggestions: [] });

    await mapboxSearchHandler(req({ query: '12 Main St', sessionToken: 'sess-abcdef01' }));

    expect(sentToken(calls[0])).toBe('pk.a-real-token');
  });

  it('leaves a correctly stored token exactly as it is', async () => {
    const calls = captureFetch({ suggestions: [] });

    await mapboxSearchHandler(req({ query: '12 Main St', sessionToken: 'sess-abcdef01' }));

    expect(sentToken(calls[0])).toBe('pk.a-real-token');
  });

  it('a whitespace-only secret is refused as unconfigured, not sent upstream', async () => {
    process.env.MAPBOX_ACCESS_TOKEN = '\n';
    const calls = captureFetch({ suggestions: [] });

    await expect(
      mapboxSearchHandler(req({ query: '12 Main St', sessionToken: 'sess-abcdef01' })),
    ).rejects.toThrow('mapbox_signing_not_configured');
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('mapboxSearch guards', () => {
  it('refuses an unauthenticated caller', async () => {
    await expect(
      mapboxSearchHandler(req({ query: '12 Main St', sessionToken: 'sess-abcdef01' }, null)),
    ).rejects.toBeInstanceOf(HttpsError);
  });

  it('returns an empty list for a query too short to search, without calling Mapbox', async () => {
    const calls = captureFetch({ suggestions: [] });
    const out = await mapboxSearchHandler(req({ query: 'a', sessionToken: 'sess-abcdef01' }));
    expect(out.suggestions).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('surfaces an upstream 401 as mapbox_401', async () => {
    captureFetch({}, false, 401);
    await expect(
      mapboxSearchHandler(req({ query: '12 Main St', sessionToken: 'sess-abcdef01' })),
    ).rejects.toThrow('mapbox_401');
  });
});
