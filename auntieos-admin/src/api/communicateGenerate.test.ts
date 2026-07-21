import { describe, it, expect, vi, beforeEach } from 'vitest';

const { authState } = vi.hoisted(() => ({ authState: { currentUser: null as null | { getIdToken: () => Promise<string> } } }));
vi.mock('../lib/firebase', () => ({ auth: authState }));

import {
  generateDraft,
  sendPersonalizedMessage,
  draftOpening,
  GenerateDraftError,
  SendMessageError,
  type GenerateDraftArgs,
  type SendPersonalizedArgs,
} from './communicateGenerate';

function fakeUser(token = 'tok-123') {
  return { getIdToken: vi.fn().mockResolvedValue(token) };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  authState.currentUser = null;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

const generateArgs: GenerateDraftArgs = {
  communication_type: 'email',
  recipient: 'Dana Halbrook',
  raw_notes: 'Nova did great at the park today.',
};

describe('generateDraft', () => {
  it('throws without a signed-in admin, and never calls fetch', async () => {
    await expect(generateDraft(generateArgs)).rejects.toThrow(GenerateDraftError);
    await expect(generateDraft(generateArgs)).rejects.toThrow(/sign-in required/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs to /api/generate with a Bearer token and the request verbatim', async () => {
    authState.currentUser = fakeUser('abc.def');
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        generated_copy: 'Nova had the best day at the park today.',
        // Blank because this call did not set want_title.
        generated_title: '',
        communication_type: 'email',
        kinfolk_name: 'Dana Halbrook',
        kinfolk_id: 'kf1',
        draft_id: 'd1',
        model: 'claude-sonnet-4-5',
        draftWriteFailed: false,
        warnings: [],
      }),
    );

    const result = await generateDraft(generateArgs);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/generate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer abc.def',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(generateArgs),
      }),
    );
    expect(result).toEqual({
      generated_copy: 'Nova had the best day at the park today.',
      // Blank because this call did not set want_title.
      generated_title: '',
      communication_type: 'email',
      kinfolk_name: 'Dana Halbrook',
      kinfolk_id: 'kf1',
      draft_id: 'd1',
      model: 'claude-sonnet-4-5',
      draftWriteFailed: false,
      warnings: [],
    });
  });

  it('surfaces draftWriteFailed and warnings rather than hiding a partial failure', async () => {
    authState.currentUser = fakeUser();
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        generated_copy: 'Some real copy.',
        communication_type: 'email',
        draft_id: null,
        draftWriteFailed: true,
        warnings: ['Draft write failed: permission-denied'],
      }),
    );
    const result = await generateDraft(generateArgs);
    expect(result.draftWriteFailed).toBe(true);
    expect(result.draft_id).toBeNull();
    expect(result.warnings).toEqual(['Draft write failed: permission-denied']);
  });

  it('fails loud on a no-match 404, naming the backend error rather than a generic message', async () => {
    authState.currentUser = fakeUser();
    fetchMock.mockResolvedValue(
      jsonResponse(404, { generated_copy: '', communication_type: 'email', error: 'No Kinfolk match for "Zzz"' }),
    );
    await expect(generateDraft(generateArgs)).rejects.toThrow('No Kinfolk match for "Zzz"');
  });

  it('fails loud on a rate-limit 429', async () => {
    authState.currentUser = fakeUser();
    fetchMock.mockResolvedValue(
      jsonResponse(429, { generated_copy: '', communication_type: 'email', error: 'generate_rate_limit_exceeded' }),
    );
    await expect(generateDraft(generateArgs)).rejects.toThrow('generate_rate_limit_exceeded');
  });

  it('fails loud on a network error rather than swallowing it', async () => {
    authState.currentUser = fakeUser();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(generateDraft(generateArgs)).rejects.toThrow(/generate request failed: Failed to fetch/);
  });

  it('never fabricates a success on an empty generated_copy', async () => {
    authState.currentUser = fakeUser();
    fetchMock.mockResolvedValue(jsonResponse(200, { generated_copy: '', communication_type: 'email' }));
    await expect(generateDraft(generateArgs)).rejects.toThrow(/no draft copy/i);
  });

  it('passes avoid_opening through on a regenerate call', async () => {
    authState.currentUser = fakeUser();
    fetchMock.mockResolvedValue(
      jsonResponse(200, { generated_copy: 'A fresh take.', communication_type: 'email' }),
    );
    await generateDraft({ ...generateArgs, avoid_opening: 'Well, Nova' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ ...generateArgs, avoid_opening: 'Well, Nova' });
  });
});

describe('draftOpening', () => {
  it('returns the first sentence when punctuation appears early', () => {
    expect(draftOpening('Well, Nova had a great day. She ran for an hour straight.')).toBe('Well, Nova had a great day.');
  });

  it('falls back to the first N words when no sentence-ending punctuation is found within them', () => {
    expect(draftOpening('Nova ran and ran and ran and ran and ran and ran and ran across the whole yard')).toBe(
      'Nova ran and ran and ran and ran',
    );
  });

  it('returns an empty string for blank input', () => {
    expect(draftOpening('   ')).toBe('');
  });

  it('trims surrounding whitespace', () => {
    expect(draftOpening('  Hello there.  ')).toBe('Hello there.');
  });
});

const sendArgs: SendPersonalizedArgs = {
  channel: 'email',
  message_body: 'Nova had a great day today.',
  kinfolk_id: 'kf1',
  recipient_email: 'dana@example.com',
};

describe('sendPersonalizedMessage', () => {
  it('throws without a signed-in admin, and never calls fetch', async () => {
    await expect(sendPersonalizedMessage(sendArgs)).rejects.toThrow(SendMessageError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs to /api/send-message with a Bearer token and the payload verbatim', async () => {
    authState.currentUser = fakeUser('xyz.789');
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, sid: 'SM123' }));

    const result = await sendPersonalizedMessage(sendArgs);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/send-message',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer xyz.789' }),
        body: JSON.stringify(sendArgs),
      }),
    );
    expect(result).toEqual({ ok: true, providerId: 'SM123' });
  });

  it('reads message_sid when sid is absent (defensive, provider-shape tolerant)', async () => {
    authState.currentUser = fakeUser();
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, message_sid: 'MS456' }));
    const result = await sendPersonalizedMessage(sendArgs);
    expect(result.providerId).toBe('MS456');
  });

  it('fails loud on a provider error field even with an HTTP 200 (never a fabricated success)', async () => {
    authState.currentUser = fakeUser();
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: false, error: 'recipient_opted_out' }));
    await expect(sendPersonalizedMessage(sendArgs)).rejects.toThrow('recipient_opted_out');
  });

  it('fails loud on a non-JSON-normalized provider failure', async () => {
    authState.currentUser = fakeUser();
    fetchMock.mockResolvedValue(
      jsonResponse(502, { error: 'upstream_provider_failure', provider_error: 'cf_body_rewritten' }),
    );
    await expect(sendPersonalizedMessage(sendArgs)).rejects.toThrow('upstream_provider_failure');
  });

  it('fails loud on a network error', async () => {
    authState.currentUser = fakeUser();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(sendPersonalizedMessage(sendArgs)).rejects.toThrow(/sendMessage request failed/);
  });
});
