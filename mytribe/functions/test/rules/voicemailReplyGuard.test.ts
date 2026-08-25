import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown } from './setup';

/**
 * Issue #581: `voicemails/{id}` is client-writable ONLY via three keys -
 * `replyStatus`, `repliedAt`, `replyLogId` - and all three clients (the React
 * admin's `markVoicemail`, Android's `AuntieRepository.markVoicemail*`, and
 * desktop's `JvmFirestoreRest.patchFields` REST PATCH, which carries the
 * caller's own Firebase ID token and so is bound by this rule exactly like
 * the other two) wrote those keys through a bare `isAuntie()` grant with no
 * floor under it.
 *
 * A stray tap on Mark read or Dismiss for a voicemail ALREADY marked
 * `replied` overwrote `repliedAt` and `replyLogId` with empty strings and put
 * `replyStatus` back to `read`/`dismissed`, destroying the only record of who
 * answered and when. THIS FILE is what makes the fix a real floor rather than
 * three separate UI checks any one of which can regress: the rule below is
 * the single place all three surfaces are bound.
 */

const AUNTIE = { admin: true };
const VOICEMAIL = 'voicemails/vm1';

async function seedVoicemail(fields: Record<string, unknown>): Promise<void> {
  const env = await getEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(VOICEMAIL).set({
      callerNumber: '+15551234567',
      transcript: 'call me back',
      audioUrl: 'https://example.test/vm1.mp3',
      timestamp: '2026-08-01T09:00:00Z',
      ...fields,
    });
  });
}

describe('rules: voicemails reply metadata cannot be clobbered once replied', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  // ── The hole this closes ──────────────────────────────────────────────────

  it('Mark read can no longer blank repliedAt/replyLogId on an already-replied voicemail', async () => {
    await seedVoicemail({ replyStatus: 'replied', repliedAt: '2026-08-01T09:05:00Z', replyLogId: 'log-1' });
    const env = await getEnv();
    await assertFails(
      env.authenticatedContext('auntie1', AUNTIE).firestore().doc(VOICEMAIL)
        .set({ replyStatus: 'read', repliedAt: '', replyLogId: '' }, { merge: true }),
    );
  });

  it('Dismiss can no longer blank repliedAt/replyLogId on an already-replied voicemail', async () => {
    await seedVoicemail({ replyStatus: 'replied', repliedAt: '2026-08-01T09:05:00Z', replyLogId: 'log-1' });
    const env = await getEnv();
    await assertFails(
      env.authenticatedContext('auntie1', AUNTIE).firestore().doc(VOICEMAIL)
        .set({ replyStatus: 'dismissed', repliedAt: '', replyLogId: '' }, { merge: true }),
    );
  });

  // NOT GUARDED, deliberately: a merge write that leaves `replyStatus` at
  // 'replied' while blanking `repliedAt`/`replyLogId` on its own passes the
  // rule below (post-merge `replyStatus` is still 'replied'). No client write
  // path produces that shape - all three `markVoicemail*` writers always set
  // `replyStatus` alongside the two fields together - so pinning against it
  // would only protect against a write nothing in this codebase makes, at the
  // cost of blocking a LEGITIMATE re-reply from ever moving `repliedAt`
  // forward without also repeating `replyStatus: 'replied'` in the same call
  // (which every real caller already does). See ThreadActionsCard.tsx /
  // AuntieRepository.markVoicemailReplied / FirestoreClient.markVoicemailReplied.

  // ── What deliberately still works ─────────────────────────────────────────

  it('an unread voicemail can still be marked read', async () => {
    await seedVoicemail({ replyStatus: 'unread', repliedAt: '', replyLogId: '' });
    const env = await getEnv();
    await assertSucceeds(
      env.authenticatedContext('auntie1', AUNTIE).firestore().doc(VOICEMAIL)
        .set({ replyStatus: 'read', repliedAt: '', replyLogId: '' }, { merge: true }),
    );
  });

  it('an unreplied (read) voicemail can still be dismissed', async () => {
    await seedVoicemail({ replyStatus: 'read', repliedAt: '', replyLogId: '' });
    const env = await getEnv();
    await assertSucceeds(
      env.authenticatedContext('auntie1', AUNTIE).firestore().doc(VOICEMAIL)
        .set({ replyStatus: 'dismissed', repliedAt: '', replyLogId: '' }, { merge: true }),
    );
  });

  /**
   * PR #567's rule: Dismiss MARKS, it never hides - there is no
   * read/dismissed filter on this screen, so a dismissed voicemail is still a
   * row an operator can act on. Mark read is the web admin's reversal path
   * off `dismissed` (`ThreadActionsCard` keeps that button visible once
   * dismissed), so the data layer has to allow it too.
   */
  it('a dismissed voicemail can still be marked read (the reversal path)', async () => {
    await seedVoicemail({ replyStatus: 'dismissed', repliedAt: '', replyLogId: '' });
    const env = await getEnv();
    await assertSucceeds(
      env.authenticatedContext('auntie1', AUNTIE).firestore().doc(VOICEMAIL)
        .set({ replyStatus: 'read', repliedAt: '', replyLogId: '' }, { merge: true }),
    );
  });

  it('an unread voicemail can still be dismissed directly', async () => {
    await seedVoicemail({ replyStatus: 'unread', repliedAt: '', replyLogId: '' });
    const env = await getEnv();
    await assertSucceeds(
      env.authenticatedContext('auntie1', AUNTIE).firestore().doc(VOICEMAIL)
        .set({ replyStatus: 'dismissed', repliedAt: '', replyLogId: '' }, { merge: true }),
    );
  });

  it('a re-reply to an already-replied voicemail still updates repliedAt/replyLogId', async () => {
    await seedVoicemail({ replyStatus: 'replied', repliedAt: '2026-08-01T09:05:00Z', replyLogId: 'log-1' });
    const env = await getEnv();
    await assertSucceeds(
      env.authenticatedContext('auntie1', AUNTIE).firestore().doc(VOICEMAIL)
        .set({ replyStatus: 'replied', repliedAt: '2026-08-01T10:00:00Z', replyLogId: 'log-2' }, { merge: true }),
    );
  });

  it('a legacy voicemail with no replyStatus field at all can still be marked read', async () => {
    await seedVoicemail({}); // no replyStatus key on the doc
    const env = await getEnv();
    await assertSucceeds(
      env.authenticatedContext('auntie1', AUNTIE).firestore().doc(VOICEMAIL)
        .set({ replyStatus: 'read', repliedAt: '', replyLogId: '' }, { merge: true }),
    );
  });

  it('a replied voicemail still accepts unrelated non-status field patches', async () => {
    await seedVoicemail({ replyStatus: 'replied', repliedAt: '2026-08-01T09:05:00Z', replyLogId: 'log-1' });
    const env = await getEnv();
    await assertSucceeds(
      env.authenticatedContext('auntie1', AUNTIE).firestore().doc(VOICEMAIL)
        .set({ transcript: 'corrected transcript' }, { merge: true }),
    );
  });

  // ── Nothing here loosened anyone else ─────────────────────────────────────

  it('a kinfolk still cannot write this collection at all', async () => {
    await seedVoicemail({ replyStatus: 'unread', repliedAt: '', replyLogId: '' });
    const env = await getEnv();
    await assertFails(
      env.authenticatedContext('kf-user', { role: 'kinfolk', kinfolkId: 'kf1' }).firestore().doc(VOICEMAIL)
        .set({ replyStatus: 'read' }, { merge: true }),
    );
  });

  it('an unauthenticated caller still cannot write this collection', async () => {
    await seedVoicemail({ replyStatus: 'unread', repliedAt: '', replyLogId: '' });
    const env = await getEnv();
    await assertFails(
      env.unauthenticatedContext().firestore().doc(VOICEMAIL)
        .set({ replyStatus: 'read' }, { merge: true }),
    );
  });

  it('an auntie can still create and delete voicemail docs', async () => {
    const env = await getEnv();
    const fs = env.authenticatedContext('auntie1', AUNTIE).firestore();
    await assertSucceeds(fs.doc('voicemails/fresh').set({ callerNumber: '+15550000000', replyStatus: 'unread' }));
    await assertSucceeds(fs.doc('voicemails/fresh').delete());
  });
});
