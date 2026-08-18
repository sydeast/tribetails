import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: {
    currentUser: null as null | { uid: string; getIdToken: (force?: boolean) => Promise<string> },
  },
}));
vi.mock('./firebase', () => ({ auth: mockAuth }));

import { adminApiFetch, NotSignedInError } from './adminApiFetch';

/**
 * These pin the 401 behind marks 3 and 12 of the 2026-08-17 admin walk:
 * `/api/cloudinary/sign-upload` and `/api/generate` both answered
 * `401 {"error":"invalid_bearer_token"}` while callables on the same page
 * succeeded, because those two endpoints are the only ones verified with
 * `checkRevoked`. A token that is inside its validity window but older than the
 * account's `tokensValidAfterTime` passes everywhere else and fails there.
 */

function response(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as unknown as Response;
}

/** A signed-in admin whose cached token is the one the server refuses. */
function signIn(tokens: { cached: string; fresh: string }) {
  const getIdToken = vi.fn(async (force?: boolean) => (force === true ? tokens.fresh : tokens.cached));
  mockAuth.currentUser = { uid: 'admin-1', getIdToken };
  return getIdToken;
}

/** The Authorization header off one recorded `fetch` call. */
function bearerOf(call: readonly unknown[] | undefined): string {
  const init = call?.[1] as RequestInit | undefined;
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers['Authorization'] ?? '';
}

beforeEach(() => {
  mockAuth.currentUser = null;
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('adminApiFetch', () => {
  it('sends the cached token and does not refresh when the endpoint accepts it', async () => {
    const getIdToken = signIn({ cached: 'cached-token', fresh: 'fresh-token' });
    vi.mocked(fetch).mockResolvedValue(response(200));

    const resp = await adminApiFetch('/api/generate', 'generating a draft', { body: '{}' });

    expect(resp.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    expect(bearerOf(vi.mocked(fetch).mock.calls[0])).toBe('Bearer cached-token');
    expect(getIdToken).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('refreshes the token and retries ONCE when the endpoint answers 401', async () => {
    signIn({ cached: 'stale-token', fresh: 'minted-token' });
    vi.mocked(fetch).mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(200));

    const resp = await adminApiFetch('/api/cloudinary/sign-upload', 'uploading media', { body: '{}' });

    expect(resp.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bearerOf(vi.mocked(fetch).mock.calls[0])).toBe('Bearer stale-token');
    expect(bearerOf(vi.mocked(fetch).mock.calls[1])).toBe('Bearer minted-token');
  });

  it('returns the second 401 rather than looping: a refused fresh token is an account problem', async () => {
    signIn({ cached: 'stale-token', fresh: 'minted-token' });
    vi.mocked(fetch).mockResolvedValue(response(401));

    const resp = await adminApiFetch('/api/generate', 'generating a draft', { body: '{}' });

    expect(resp.status).toBe(401);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-401 failure, because a fresh token would not change it', async () => {
    signIn({ cached: 'cached-token', fresh: 'fresh-token' });
    vi.mocked(fetch).mockResolvedValue(response(500));

    const resp = await adminApiFetch('/api/generate', 'generating a draft', { body: '{}' });

    expect(resp.status).toBe(500);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('throws NotSignedInError, naming the action, before it touches the network', async () => {
    await expect(adminApiFetch('/api/generate', 'generating a draft', { body: '{}' })).rejects.toThrow(
      NotSignedInError,
    );
    await expect(adminApiFetch('/api/generate', 'generating a draft', { body: '{}' })).rejects.toThrow(
      /Sign-in required before generating a draft\./,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('owns the Authorization header: a caller cannot override it', async () => {
    signIn({ cached: 'cached-token', fresh: 'fresh-token' });
    vi.mocked(fetch).mockResolvedValue(response(200));

    await adminApiFetch('/api/generate', 'generating a draft', {
      body: '{}',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer smuggled' },
    });

    expect(bearerOf(vi.mocked(fetch).mock.calls[0])).toBe('Bearer cached-token');
  });
});
