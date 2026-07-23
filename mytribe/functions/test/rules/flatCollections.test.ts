import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, asUser } from './setup';

describe('rules: flat top-level collections', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('inviteRequests: invitee email matches token email = read OK', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('inviteRequests/i1').set({
        tribeId: 'f1', primaryUid: 'u-prim', invitedEmail: 'a@b.com',
        proposedRole: 'SECONDARY', status: 'EMAIL_SENT',
        proposedPermissions: {}, requiresAuntieAck: false,
        createdAt: new Date(), expiresAt: new Date(Date.now() + 86400000),
      });
    });
    const ctx = env.authenticatedContext('u-x', { email: 'a@b.com', email_verified: true });
    await assertSucceeds(ctx.firestore().doc('inviteRequests/i1').get());
  });

  // WARNING-17: an UNVERIFIED email claim must not satisfy the invitee branch,
  // even when the address matches invitedEmail - an unverified address is
  // attacker-controllable, so allowing it leaks invite details.
  it('inviteRequests: matching email but email_verified:false = read DENIED', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('inviteRequests/i1').set({
        tribeId: 'f1', primaryUid: 'u-prim', invitedEmail: 'a@b.com',
        proposedRole: 'SECONDARY', status: 'EMAIL_SENT',
        proposedPermissions: {}, requiresAuntieAck: false,
        createdAt: new Date(), expiresAt: new Date(Date.now() + 86400000),
      });
    });
    const ctx = env.authenticatedContext('u-unverified', { email: 'a@b.com', email_verified: false });
    await assertFails(ctx.firestore().doc('inviteRequests/i1').get());
  });

  // Same address, email_verified omitted entirely (claim absent) = DENIED.
  it('inviteRequests: matching email but no email_verified claim = read DENIED', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('inviteRequests/i1').set({
        tribeId: 'f1', primaryUid: 'u-prim', invitedEmail: 'a@b.com',
        proposedRole: 'SECONDARY', status: 'EMAIL_SENT',
        proposedPermissions: {}, requiresAuntieAck: false,
        createdAt: new Date(), expiresAt: new Date(Date.now() + 86400000),
      });
    });
    const ctx = env.authenticatedContext('u-no-claim', { email: 'a@b.com' });
    await assertFails(ctx.firestore().doc('inviteRequests/i1').get());
  });

  it('inviteRequests: stranger denied', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('inviteRequests/i1').set({
        tribeId: 'f1', primaryUid: 'u-prim', invitedEmail: 'a@b.com',
        proposedRole: 'SECONDARY', status: 'EMAIL_SENT',
        proposedPermissions: {}, requiresAuntieAck: false,
        createdAt: new Date(), expiresAt: new Date(Date.now() + 86400000),
      });
    });
    await assertFails(asUser(env, 'u-stranger').firestore().doc('inviteRequests/i1').get());
  });

  it('sharedKinTales / auditLog / activity_log / leadRequests / emailTemplates / recoveryRequests / migrationReports — all denied', async () => {
    const env = await getEnv();
    const fs = asUser(env, 'u-x').firestore();
    await assertFails(fs.doc('sharedKinTales/s1').get());
    await assertFails(fs.doc('auditLog/a1').get());
    await assertFails(fs.doc('activity_log/a1').get());
    await assertFails(fs.doc('leadRequests/l1').get());
    await assertFails(fs.doc('emailTemplates/k').get());
    await assertFails(fs.doc('recoveryRequests/r1').get());
    await assertFails(fs.doc('migrationReports/m1').get());
  });

  // These two used to target `fcmTokens` (camelCase), a collection nothing in
  // the system reads or writes, and the first asserted that a client write
  // SUCCEEDED. It did, against a phantom. The real collection is `fcm_tokens`
  // (snake), which had no rule at all and was therefore default-deny, so the
  // AuntieOS Android app's token save failed on every call while this suite
  // stayed green. Registration is callable-only now (registerFcmToken /
  // unregisterFcmToken, Admin SDK, which bypasses rules), so every client path
  // below is denied on purpose.

  it('fcm_tokens: own token write denied (callable-only)', async () => {
    const env = await getEnv();
    await assertFails(
      asUser(env, 'u-x').firestore().doc('fcm_tokens/t1').set({
        uid: 'u-x', platform: 'android', token: 'tok', updatedAt: new Date(),
      }),
    );
  });

  it('fcm_tokens: foreign token write denied', async () => {
    const env = await getEnv();
    await assertFails(
      asUser(env, 'u-x').firestore().doc('fcm_tokens/t1').set({
        uid: 'u-other', token: 'tok',
      }),
    );
  });

  it('fcm_tokens: own token read denied (nothing client-side reads it)', async () => {
    const env = await getEnv();
    await assertFails(asUser(env, 'u-x').firestore().doc('fcm_tokens/t1').get());
  });

  it('fcmTokens: the old camelCase name has no rule and stays denied', async () => {
    // Guards the rename: if someone reintroduces a `fcmTokens` rule, the split
    // that caused this bug is back.
    const env = await getEnv();
    await assertFails(
      asUser(env, 'u-x').firestore().doc('fcmTokens/t1').set({ uid: 'u-x', token: 'tok' }),
    );
  });

  // ── enhanced_bookings: AuntieOS Android's own scheduling pipeline ─────────
  // Had no rule at all, so every android booking create and list read was
  // permission-denied and looked like a broken feature (BookingRepository wraps
  // the calls in runCatching).

  it('enhanced_bookings: operator can write', async () => {
    const env = await getEnv();
    await assertSucceeds(
      env.authenticatedContext('staff-1', { admin: true }).firestore().doc('enhanced_bookings/b1').set({ kinfolkId: 'k1', status: 'scheduled' }),
    );
  });

  it('enhanced_bookings: operator can read', async () => {
    const env = await getEnv();
    await assertSucceeds(env.authenticatedContext('staff-1', { admin: true }).firestore().doc('enhanced_bookings/b1').get());
  });

  it('enhanced_bookings: a signed-in non-operator is denied', async () => {
    const env = await getEnv();
    await assertFails(asUser(env, 'u-x').firestore().doc('enhanced_bookings/b1').get());
    await assertFails(
      asUser(env, 'u-x').firestore().doc('enhanced_bookings/b1').set({ kinfolkId: 'k1' }),
    );
  });
});
