import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, asUser, asUnauth } from './setup';

/**
 * rules: /conversations/{kinfolkId} + /conversations/{kinfolkId}/messages/{id}
 *
 * S5: the MyTribe portal's Messages screen added a realtime `onSnapshot`
 * listener (web/src/lib/messagesListener.ts), which needs client READ access
 * this collection never had before (writes stay admin/callable-only — every
 * mutation still goes through sendKinfolkMessage/appendMessage's Admin SDK
 * path, which bypasses rules entirely). Gated identically to
 * kin_care_sessions/{id}/breadcrumbs: a kinfolk may read only their OWN
 * household's thread (kinfolkId == their token's kinfolkId claim).
 */
describe('rules: /conversations/{kinfolkId}', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  async function seedThread(kinfolkId: string) {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await db.doc(`conversations/${kinfolkId}`).set({
        kinfolkId,
        kinfolkName: 'Test Family',
        lastMessagePreview: 'hi',
        messageCount: 1,
      });
      await db.doc(`conversations/${kinfolkId}/messages/m1`).set({
        senderRole: 'kinfolk',
        senderUid: 'u-kin',
        body: 'hi',
        createdAtMs: Date.now(),
      });
    });
  }

  it('a kinfolk can read their OWN thread doc and its messages', async () => {
    const env = await getEnv();
    await seedThread('k1');
    const db = asUser(env, 'u-kin', { role: 'kinfolk', kinfolkId: 'k1' }).firestore();
    await assertSucceeds(db.doc('conversations/k1').get());
    await assertSucceeds(db.doc('conversations/k1/messages/m1').get());
  });

  it('a kinfolk cannot read a DIFFERENT household thread', async () => {
    const env = await getEnv();
    await seedThread('k1');
    const db = asUser(env, 'u-other', { role: 'kinfolk', kinfolkId: 'k2' }).firestore();
    await assertFails(db.doc('conversations/k1').get());
    await assertFails(db.doc('conversations/k1/messages/m1').get());
  });

  it('an auntie (admin claim) can read any thread', async () => {
    const env = await getEnv();
    await seedThread('k1');
    const db = asUser(env, 'u-auntie', { admin: true }).firestore();
    await assertSucceeds(db.doc('conversations/k1').get());
    await assertSucceeds(db.doc('conversations/k1/messages/m1').get());
  });

  it('an unauthenticated caller cannot read any thread', async () => {
    const env = await getEnv();
    await seedThread('k1');
    await assertFails(asUnauth(env).firestore().doc('conversations/k1').get());
  });

  it('a kinfolk cannot write to their own thread doc — writes stay admin/callable-only', async () => {
    const env = await getEnv();
    await seedThread('k1');
    const ctx = asUser(env, 'u-kin', { role: 'kinfolk', kinfolkId: 'k1' });
    await assertFails(ctx.firestore().doc('conversations/k1').set({ kinfolkName: 'hacked' }, { merge: true }));
  });

  it('a kinfolk cannot write directly into their own message subcollection', async () => {
    const env = await getEnv();
    await seedThread('k1');
    const ctx = asUser(env, 'u-kin', { role: 'kinfolk', kinfolkId: 'k1' });
    await assertFails(
      ctx.firestore().doc('conversations/k1/messages/m2').set({
        senderRole: 'kinfolk',
        senderUid: 'u-kin',
        body: 'bypassing sendKinfolkMessage entirely',
        createdAtMs: Date.now(),
      }),
    );
  });
});
