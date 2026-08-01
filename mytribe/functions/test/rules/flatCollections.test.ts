import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, asUser } from './setup';

/** An AuntieOS operator: the `admin: true` custom claim isAuntie() keys on. */
function asAuntie(env: Awaited<ReturnType<typeof getEnv>>) {
  return env.authenticatedContext('staff-1', { admin: true });
}

/** A Stage-0I test admin: testTribeId claim, deliberately NO admin claim. */
function asTestAdmin(env: Awaited<ReturnType<typeof getEnv>>, uid = 'test-admin-uid') {
  return env.authenticatedContext(uid, { testTribeId: 'test-kinfolk-001' });
}

describe('rules: flat top-level collections', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('inviteRequests: invitee email matches token email = read OK', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('inviteRequests/i1').set({
        tribeId: 'f1', primaryUid: 'u-prim', invitedEmail: 'a@b.com',
        proposedRole: 'SECONDARY', status: 'EMAIL_SENT',
        proposedPermissions: {},
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
        proposedPermissions: {},
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
        proposedPermissions: {},
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
        proposedPermissions: {},
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

  // ── business_settings: was `read: if signedIn()` ──────────────────────────
  // One document holds serviceRates, businessHours, calendarSyncId,
  // travelBufferMinutes, GPS settings and the mytribePortal config, and the
  // signed-in read handed all of it to every kinfolk. The portal never wanted
  // it: getBusinessContact projects four fields on purpose. Read is now
  // isAuntie() || isTestAdmin() - the sandbox branch is load-bearing because
  // AuntieOS Android fans out getBusinessSettings on Home.

  async function seedBusinessSettings(): Promise<void> {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('business_settings/business_settings').set({
        businessName: 'Tribe Tails',
        serviceRates: { walk30: 2500 },
        calendarSyncId: 'ops@group.calendar.google.com',
        travelBufferMinutes: 15,
      });
    });
  }

  it('business_settings: a signed-in kinfolk CANNOT read the operational doc', async () => {
    const env = await getEnv();
    await seedBusinessSettings();
    await assertFails(
      asUser(env, 'u-kinfolk').firestore().doc('business_settings/business_settings').get(),
    );
  });

  it('business_settings: an unauth caller cannot read it either', async () => {
    const env = await getEnv();
    await seedBusinessSettings();
    const { asUnauth } = await import('./setup');
    await assertFails(
      asUnauth(env).firestore().doc('business_settings/business_settings').get(),
    );
  });

  it('business_settings: the operator can still read AND write', async () => {
    const env = await getEnv();
    await seedBusinessSettings();
    await assertSucceeds(asAuntie(env).firestore().doc('business_settings/business_settings').get());
    await assertSucceeds(
      asAuntie(env).firestore().doc('business_settings/business_settings')
        .set({ travelBufferMinutes: 20 }, { merge: true }),
    );
  });

  it('business_settings: the test-admin sandbox can still read it (Android Home)', async () => {
    const env = await getEnv();
    await seedBusinessSettings();
    await assertSucceeds(
      asTestAdmin(env).firestore().doc('business_settings/business_settings').get(),
    );
  });

  // ── operators: collection + isOperator() helper both removed ──────────────
  // Nothing in the tree reads, writes or seeds `operators`. The rule granted
  // self-read, so this pins the default-deny that replaced it - including for
  // the uid that owns the one stale prod document, which is an admin anyway.

  it('operators: self-read is denied (collection retired, rule deleted)', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('operators/u-owner').set({ email: 'owner@x.com' });
    });
    await assertFails(asUser(env, 'u-owner').firestore().doc('operators/u-owner').get());
  });

  it('operators: even an operator cannot read it, and no one can write it', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('operators/u-owner').set({ email: 'owner@x.com' });
    });
    await assertFails(asAuntie(env).firestore().doc('operators/u-owner').get());
    await assertFails(asUser(env, 'u-owner').firestore().doc('operators/u-owner').set({ email: 'x' }));
  });

  // ── activity_log: duplicate match block deleted ───────────────────────────
  // Two identical `match /activity_log/{id}` blocks existed and Firestore UNIONs
  // them, so narrowing one would have been silently undone by the other. These
  // pin the surviving block's exact shape: operator read + create, never update
  // or delete (forensic non-repudiation), nothing for anyone else.

  it('activity_log: operator can read and create, but never update or delete', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('activity_log/a1').set({ action: 'SEEDED', at: new Date() });
    });
    const fs = asAuntie(env).firestore();
    await assertSucceeds(fs.doc('activity_log/a1').get());
    await assertSucceeds(fs.doc('activity_log/a2').set({ action: 'ADMIN_X', at: new Date() }));
    await assertFails(fs.doc('activity_log/a1').update({ action: 'TAMPERED' }));
    await assertFails(fs.doc('activity_log/a1').delete());
  });

  it('activity_log: a signed-in non-operator cannot create an entry', async () => {
    const env = await getEnv();
    await assertFails(
      asUser(env, 'u-x').firestore().doc('activity_log/a3').set({ action: 'FORGED' }),
    );
  });

  // ── expenses / supplies / expirations: write grant removed ────────────────
  // Their own comment said mutations flow through logExpense / adjustSupply /
  // upsertSupply / upsertExpiration so the audit entry is bound to the
  // mutation - and then allowed a direct admin-client write that produces no
  // activity_log entry at all. Read stays admin-scoped so the widgets can list.

  it('expenses / supplies / expirations: operator reads OK, direct writes denied', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await db.doc('expenses/e1').set({ kind: 'gas', amountCents: 4200 });
      await db.doc('supplies/s1').set({ name: 'Poop bags', onHand: 4, par: 10 });
      await db.doc('expirations/x1').set({ label: 'Gate code', dateIso: '2026-09-01' });
    });
    const fs = asAuntie(env).firestore();
    await assertSucceeds(fs.doc('expenses/e1').get());
    await assertSucceeds(fs.doc('supplies/s1').get());
    await assertSucceeds(fs.doc('expirations/x1').get());
    await assertFails(fs.doc('expenses/e1').update({ amountCents: 1 }));
    await assertFails(fs.doc('supplies/s1').update({ onHand: 999 }));
    await assertFails(fs.doc('expirations/x1').update({ dateIso: '2099-01-01' }));
    await assertFails(fs.doc('expenses/e2').set({ kind: 'gas', amountCents: 1 }));
  });

  it('expenses / supplies / expirations: a non-operator gets nothing', async () => {
    const env = await getEnv();
    const fs = asUser(env, 'u-x').firestore();
    await assertFails(fs.doc('expenses/e1').get());
    await assertFails(fs.doc('supplies/s1').get());
    await assertFails(fs.doc('expirations/x1').get());
    await assertFails(fs.doc('expenses/e1').set({ kind: 'gas', amountCents: 1 }));
  });

  // ── dynamic_fields: rule deleted (field-authoring system retired) ─────────
  // The look-alike neighbours are still live, so both halves are asserted here:
  // if someone deletes dynamic_field_values or field_definitions by association,
  // the second test catches it.

  it('dynamic_fields: retired collection is default-deny even for the operator', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('dynamic_fields/df1').set({ name: 'gate_code', appliesTo: 'kinfolk' });
    });
    const fs = asAuntie(env).firestore();
    await assertFails(fs.doc('dynamic_fields/df1').get());
    await assertFails(fs.doc('dynamic_fields/df2').set({ name: 'x' }));
  });

  it('dynamic_field_values + field_definitions: STILL live, operator read+write OK', async () => {
    const env = await getEnv();
    const fs = asAuntie(env).firestore();
    await assertSucceeds(fs.doc('dynamic_field_values/v1').set({ fieldId: 'f1', value: 'x' }));
    await assertSucceeds(fs.doc('dynamic_field_values/v1').get());
    await assertSucceeds(fs.doc('field_definitions/f1').set({ name: 'gate_code' }));
    await assertSucceeds(fs.doc('field_definitions/f1').get());
  });

  // ── n8nIpRateLimits: rule deleted with the n8n retirement ─────────────────
  // Only writer was the Admin SDK (bypasses rules); the admin read grant was for
  // monitoring nobody built. The neighbouring ledgers stay readable.

  it('n8nIpRateLimits: retired ledger is default-deny even for the operator', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('n8nIpRateLimits/hash1').set({ hits: [1, 2, 3] });
    });
    await assertFails(asAuntie(env).firestore().doc('n8nIpRateLimits/hash1').get());
  });

  it('the surviving rate-limit ledgers still read for the operator', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await db.doc('ipRateLimits/k1').set({ hits: 1 });
      await db.doc('securityRateLimits/k1').set({ hits: 1 });
      await db.doc('stripeEvents/evt_1').set({ seen: true });
    });
    const fs = asAuntie(env).firestore();
    await assertSucceeds(fs.doc('ipRateLimits/k1').get());
    await assertSucceeds(fs.doc('securityRateLimits/k1').get());
    await assertSucceeds(fs.doc('stripeEvents/evt_1').get());
    await assertFails(fs.doc('ipRateLimits/k1').set({ hits: 0 }));
  });

  // ── notifications: dead third branch dropped from both read gates ─────────
  // `isTestAdmin() && recipientUid == request.auth.uid` was a strict subset of
  // the `signedIn() && ...` branch above it (isTestAdmin implies auth), so it
  // could never decide. These pin that removing it changed no outcome: the
  // recipient branch already covers a test admin reading its own dispatch.

  async function seedNotification(recipientUid: string): Promise<void> {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await db.doc('notifications/n1').set({ recipientUid, key: 'kincare.requested' });
      await db.doc('notifications/n1/channels/email').set({ status: 'SENT' });
    });
  }

  it('notifications: the recipient reads their own dispatch and its channels', async () => {
    const env = await getEnv();
    await seedNotification('u-recipient');
    const fs = asUser(env, 'u-recipient').firestore();
    await assertSucceeds(fs.doc('notifications/n1').get());
    await assertSucceeds(fs.doc('notifications/n1/channels/email').get());
  });

  it('notifications: a test admin who IS the recipient still reads it (branch was redundant)', async () => {
    const env = await getEnv();
    await seedNotification('test-admin-uid');
    const fs = asTestAdmin(env).firestore();
    await assertSucceeds(fs.doc('notifications/n1').get());
    await assertSucceeds(fs.doc('notifications/n1/channels/email').get());
  });

  it('notifications: a test admin who is NOT the recipient is denied (as before)', async () => {
    const env = await getEnv();
    await seedNotification('someone-else');
    const fs = asTestAdmin(env).firestore();
    await assertFails(fs.doc('notifications/n1').get());
    await assertFails(fs.doc('notifications/n1/channels/email').get());
  });

  it('notifications: a non-recipient is denied, the operator is not, nobody writes', async () => {
    const env = await getEnv();
    await seedNotification('u-recipient');
    await assertFails(asUser(env, 'u-other').firestore().doc('notifications/n1').get());
    await assertFails(asUser(env, 'u-other').firestore().doc('notifications/n1/channels/email').get());
    await assertSucceeds(asAuntie(env).firestore().doc('notifications/n1').get());
    await assertFails(
      asUser(env, 'u-recipient').firestore().doc('notifications/n1').update({ read: true }),
    );
  });
});
