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
  splitSubjectLine,
  GenerateDraftError,
  GENERATE_FAILED_COPY,
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
  /**
   * Mark 12 of the 2026-08-17 walk was filed as "generator down". The walk's
   * capture says otherwise: 401 {"error":"invalid_bearer_token"}, with
   * `recap_recent_comms` returning 200 on the same page seconds earlier. The
   * generator is one of two endpoints verified with `checkRevoked`, so it is
   * the only place a cached-but-superseded token shows up.
   */
  it('refreshes the token and retries once when the generator refuses the cached one', async () => {
    const getIdToken = vi.fn(async (force?: boolean) => (force === true ? 'fresh.tok' : 'stale.tok'));
    authState.currentUser = { getIdToken };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: 'invalid_bearer_token' }))
      .mockResolvedValueOnce(jsonResponse(200, { generated_copy: 'copy', communication_type: 'email' }));
    const result = await generateDraft(generateArgs);
    expect(result.generated_copy).toBe('copy');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, retry] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((retry.headers as Record<string, string>).Authorization).toBe('Bearer fresh.tok');
  });
  it('says the sign-in was refused, not "invalid_bearer_token", when a fresh token fails too', async () => {
    authState.currentUser = fakeUser('any.tok');
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'invalid_bearer_token' }));
    await expect(generateDraft(generateArgs)).rejects.toThrow(/sign out and back in/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('#1610: a "Subject:" line in the copy leaves the body and fills a blank title', async () => {
    authState.currentUser = fakeUser('abc.def');
    fetchMock.mockResolvedValue(
      jsonResponse(200, { generated_copy: 'Subject: Biscuit had a big day\n\nHi Dana,', communication_type: 'email' }),
    );
    const out = await generateDraft(generateArgs);
    expect(out.generated_copy).toBe('Hi Dana,');
    expect(out.generated_title).toBe('Biscuit had a big day');
  });
  it('#1610: a title the server sent wins over the copy\'s own subject line', async () => {
    authState.currentUser = fakeUser('abc.def');
    fetchMock.mockResolvedValue(
      jsonResponse(200, { generated_copy: 'Subject: Other\nHi', generated_title: 'Server title', communication_type: 'email' }),
    );
    const out = await generateDraft(generateArgs);
    expect(out.generated_copy).toBe('Hi');
    expect(out.generated_title).toBe('Server title');
  });
  it('forwards a resolved kinfolk_id, so the server reads the household directly instead of matching a name', async () => {
    authState.currentUser = fakeUser('abc.def');
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        generated_copy: 'copy',
        communication_type: 'email',
        draft_id: 'd1',
      }),
    );

    await generateDraft({ ...generateArgs, kinfolk_id: 'kf-real-id' });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body['kinfolk_id']).toBe('kf-real-id');
    // The name rides along for the draft doc and the 404 copy, but it is no
    // longer what decides which household the model reads.
    expect(body['recipient']).toBe('Dana Halbrook');
  });

  it('omits kinfolk_id entirely when the caller has no resolved household', async () => {
    authState.currentUser = fakeUser('abc.def');
    fetchMock.mockResolvedValue(jsonResponse(200, { generated_copy: 'copy', communication_type: 'email' }));

    await generateDraft(generateArgs);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect('kinfolk_id' in body).toBe(false);
  });

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

  it('says the daily limit in plain words, never the stored code (#2052)', async () => {
    authState.currentUser = fakeUser();
    fetchMock.mockResolvedValue(
      jsonResponse(429, { generated_copy: '', communication_type: 'email', error: 'generate_rate_limit_exceeded' }),
    );
    await expect(generateDraft(generateArgs)).rejects.toThrow(/written all she can for today/);
    await expect(generateDraft(generateArgs)).rejects.not.toThrow(/rate_limit/);
  });
  it('shows the plain sentence the generator sends, as sent (#2052)', async () => {
    authState.currentUser = fakeUser();
    const copy = "Auntie's draft kept bringing up Kiwi, who is not on this visit, so it was thrown away. Your notes are untouched. Try again, or write the tale yourself.";
    fetchMock.mockResolvedValue(
      jsonResponse(422, { generated_copy: '', communication_type: 'visit_report', error: copy, error_code: 'draft_names_kin_not_on_visit' }),
    );
    await expect(generateDraft(generateArgs)).rejects.toThrow(copy);
  });
  it.each([
    ['a stored code', 'anthropic_api_key_not_configured'],
    ['the provider error an older generator passed through', 'Claude API error: 529 overloaded_error request_id=req_011'],
    ['a record id an older generator put in its message', 'No Kinfolk with id "kf_8f2a91"'],
    ['a server file path', 'Voice source file not found at /workspace/voice/01_Voice_Bible.md'],
  ])('never shows %s (#2052)', async (_what, error) => {
    authState.currentUser = fakeUser();
    fetchMock.mockResolvedValue(jsonResponse(502, { generated_copy: '', communication_type: 'email', error }));
    await expect(generateDraft(generateArgs)).rejects.toThrow(GENERATE_FAILED_COPY);
  });
  it('a sign-in the generator is closed to is told so, not told to try again', async () => {
    authState.currentUser = fakeUser();
    fetchMock.mockResolvedValue(jsonResponse(403, { error: 'admin_required' }));
    await expect(generateDraft(generateArgs)).rejects.toThrow('Only the owner can ask Auntie for a draft.');
  });
  it('a failure with no message at all is still a plain sentence, with no status number', async () => {
    authState.currentUser = fakeUser();
    fetchMock.mockResolvedValue(jsonResponse(500, {}));
    await expect(generateDraft(generateArgs)).rejects.toThrow(GENERATE_FAILED_COPY);
  });
  it('sends the visit and the ticked care tasks through untouched (#2079)', async () => {
    authState.currentUser = fakeUser();
    fetchMock.mockResolvedValue(jsonResponse(200, { generated_copy: 'ok', communication_type: 'visit_report' }));
    await generateDraft({
      ...generateArgs,
      communication_type: 'visit_report',
      session_id: 'sess1',
      care_tasks: [{ text: 'Fed', kin_name: 'Biscuit' }],
    });
    const sent = JSON.parse(String((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(sent).toMatchObject({ session_id: 'sess1', care_tasks: [{ text: 'Fed', kin_name: 'Biscuit' }] });
  });

  it('fails loud on a network error rather than swallowing it', async () => {
    authState.currentUser = fakeUser();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(generateDraft(generateArgs)).rejects.toThrow(/could not be reached/i);
    await expect(generateDraft(generateArgs)).rejects.not.toThrow(/Failed to fetch/);
  });

  it('never fabricates a success on an empty generated_copy', async () => {
    authState.currentUser = fakeUser();
    fetchMock.mockResolvedValue(jsonResponse(200, { generated_copy: '', communication_type: 'email' }));
    await expect(generateDraft(generateArgs)).rejects.toThrow(GENERATE_FAILED_COPY);
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
describe('splitSubjectLine (#1610)', () => {
  it('leaves copy with no leading subject line alone', () => {
    expect(splitSubjectLine('Hi, the subject: is Biscuit')).toEqual({ subject: '', body: 'Hi, the subject: is Biscuit' });
  });
  it('handles a bold markdown subject', () => {
    expect(splitSubjectLine('**Subject:** Big day\nHi')).toEqual({ subject: 'Big day', body: 'Hi' });
  });
});
