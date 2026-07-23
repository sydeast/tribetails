import { describe, it, expect, vi, beforeEach } from 'vitest';

const { authState, callMock } = vi.hoisted(() => ({
  authState: { currentUser: null as null | { getIdToken: () => Promise<string> } },
  callMock: vi.fn(),
}));
vi.mock('../lib/firebase', () => ({ auth: authState }));
// The send is an onCall now (MyTribe `sendExternalMessage`), not a fetch to the
// retired n8n proxy, so it goes through lib/fns.ts's `call`.
vi.mock('../lib/fns', () => ({ call: callMock }));

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
  callMock.mockReset();
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
  subject: 'Nova had a great day',
  kinfolk_id: 'kf1',
  recipient_email: 'dana@example.com',
};

describe('sendPersonalizedMessage', () => {
  // Was five tests against a stubbed `fetch` to /api/send-message, which the
  // hosting rewrite pointed at an AuntieOS proxy for the retired n8n webhook.
  // They passed while every real send in prod failed. The send is now MyTribe's
  // `sendExternalMessage` onCall, so these drive the callable seam instead.
  it('calls sendExternalMessage with the mapped payload', async () => {
    callMock.mockResolvedValue({ ok: true, channel: 'email', providerMessageId: 'SM123' });
    const result = await sendPersonalizedMessage(sendArgs);
    expect(callMock).toHaveBeenCalledWith('sendExternalMessage', {
      channel: 'email',
      to: 'dana@example.com',
      body: 'Nova had a great day today.',
      subject: 'Nova had a great day',
      transactional: true,
    });
    expect(result).toEqual({ ok: true, providerId: 'SM123' });
  });
  it('sends sms to the phone number and omits subject entirely', async () => {
    callMock.mockResolvedValue({ ok: true, channel: 'sms', providerMessageId: 'SM999' });
    await sendPersonalizedMessage({
      channel: 'sms',
      message_body: 'On my way.',
      kinfolk_id: 'kf1',
      recipient_phone: '+15125551234',
    });
    expect(callMock).toHaveBeenCalledWith('sendExternalMessage', {
      channel: 'sms',
      to: '+15125551234',
      body: 'On my way.',
      transactional: true,
    });
  });
  it('marks the send transactional so a bulk opt-out cannot drop a 1:1 note', async () => {
    callMock.mockResolvedValue({ ok: true, channel: 'email', providerMessageId: 'x' });
    await sendPersonalizedMessage(sendArgs);
    expect(callMock.mock.calls[0]?.[1]).toMatchObject({ transactional: true });
  });
  it('refuses an email with no subject, without calling the backend', async () => {
    await expect(
      sendPersonalizedMessage({ ...sendArgs, subject: '   ' }),
    ).rejects.toThrow(/subject is required/i);
    expect(callMock).not.toHaveBeenCalled();
  });
  it('refuses a recipient with no address on file, without calling the backend', async () => {
    await expect(
      sendPersonalizedMessage({ ...sendArgs, recipient_email: '' }),
    ).rejects.toThrow(/no email address/i);
    await expect(
      sendPersonalizedMessage({ channel: 'sms', message_body: 'hi', recipient_phone: '' }),
    ).rejects.toThrow(/no phone number/i);
    expect(callMock).not.toHaveBeenCalled();
  });
  it('refuses an empty body, without calling the backend', async () => {
    await expect(
      sendPersonalizedMessage({ ...sendArgs, message_body: '   ' }),
    ).rejects.toThrow(/body is empty/i);
    expect(callMock).not.toHaveBeenCalled();
  });
  it('fails loud when the callable rejects, and never fabricates a success', async () => {
    callMock.mockRejectedValue(new Error('recipient has opted out of messages'));
    await expect(sendPersonalizedMessage(sendArgs)).rejects.toThrow(SendMessageError);
    await expect(sendPersonalizedMessage(sendArgs)).rejects.toThrow(/opted out/);
  });
  it('reports a null providerId rather than inventing one', async () => {
    callMock.mockResolvedValue({ ok: true, channel: 'email' });
    const result = await sendPersonalizedMessage(sendArgs);
    expect(result).toEqual({ ok: true, providerId: null });
  });
});
