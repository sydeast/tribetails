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
  // ── business_settings: the write is shape-checked now (#519) ──────────────
  // Nothing sits in front of this document — the three admin clients write it
  // directly — so these rules are the only server-side check its operator-facing
  // configuration gets. Five Cloud Functions read those fields.
  it('business_settings: a per-section partial patch still writes, naming only its own keys', async () => {
    const env = await getEnv();
    await seedBusinessSettings();
    // The React admin's shape: one section's fields plus the stamp.
    await assertSucceeds(
      asAuntie(env).firestore().doc('business_settings/business_settings').set(
        { travelBufferMinutes: 45, defaultBookingMode: 'TIME_BLOCK', updatedAt: '2026-08-24T00:00:00Z' },
        { merge: true },
      ),
    );
    // The desktop console's shape: an arbitrary changed-field subset.
    await assertSucceeds(
      asAuntie(env).firestore().doc('business_settings/business_settings').set(
        { enableAutoReminder24h: false }, { merge: true },
      ),
    );
  });
  it('business_settings: a whole-model write of every checked field still passes', async () => {
    const env = await getEnv();
    await seedBusinessSettings();
    await assertSucceeds(
      asAuntie(env).firestore().doc('business_settings/business_settings').set({
        timeZone: 'America/Chicago',
        defaultBookingMode: 'SPECIFIC_TIME',
        defaultCalendarView: 'MONTH',
        trackingAccuracy: 'HIGH',
        allowTimeBlockBooking: true,
        allowSpecificTimeBooking: true,
        enableConflictDetection: true,
        enableAutoReminder24h: true,
        enableGPSTrackingForAllVisits: true,
        enablePhotoLocationTagging: true,
        requireArrivalDepartureVerification: true,
        autoStartTrackingOnVisitStart: true,
        allowClientLocationSharing: true,
        defaultTimeBlockDurationHours: 4,
        travelBufferMinutes: 30,
        saveRoutesForDays: 90,
        defaultEtaMinutes: 15,
        draftRetentionDays: 30,
        arrivalRadiusMeters: 150,
        timeBlocks: [{ id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true }],
        etaMinuteOptions: [5, 10, 15],
        draftRetentionOptions: [30, 60, 90],
      }, { merge: true }),
    );
  });
  it('business_settings: a wrong-typed field is refused, not stored for a Function to trip over', async () => {
    const env = await getEnv();
    await seedBusinessSettings();
    // `timeZone` as a number: `resolveBusinessOpen` would log timezone-unusable
    // and the phone line would answer as open around the clock.
    await assertFails(
      asAuntie(env).firestore().doc('business_settings/business_settings')
        .set({ timeZone: 5 }, { merge: true }),
    );
    await assertFails(
      asAuntie(env).firestore().doc('business_settings/business_settings')
        .set({ enableAutoReminder24h: 'yes' }, { merge: true }),
    );
    await assertFails(
      asAuntie(env).firestore().doc('business_settings/business_settings')
        .set({ etaMinuteOptions: '5,10,15' }, { merge: true }),
    );
  });
  it('business_settings: an out-of-range number is refused', async () => {
    const env = await getEnv();
    await seedBusinessSettings();
    await assertFails(
      asAuntie(env).firestore().doc('business_settings/business_settings')
        .set({ travelBufferMinutes: -1 }, { merge: true }),
    );
    await assertFails(
      asAuntie(env).firestore().doc('business_settings/business_settings')
        .set({ saveRoutesForDays: 0 }, { merge: true }),
    );
    await assertFails(
      asAuntie(env).firestore().doc('business_settings/business_settings')
        .set({ defaultTimeBlockDurationHours: 25 }, { merge: true }),
    );
    // #582: a radius tighter than a GPS fix's own error bar would refuse every
    // arrival, and one larger than 5 km is not a check. Both bounds match
    // ARRIVAL_RADIUS_MIN/MAX_METERS and the three admin editors.
    await assertFails(
      asAuntie(env).firestore().doc('business_settings/business_settings')
        .set({ arrivalRadiusMeters: 9 }, { merge: true }),
    );
    await assertFails(
      asAuntie(env).firestore().doc('business_settings/business_settings')
        .set({ arrivalRadiusMeters: 5001 }, { merge: true }),
    );
    await assertFails(
      asAuntie(env).firestore().doc('business_settings/business_settings')
        .set({ arrivalRadiusMeters: '150' }, { merge: true }),
    );
    await assertSucceeds(
      asAuntie(env).firestore().doc('business_settings/business_settings')
        .set({ arrivalRadiusMeters: 300 }, { merge: true }),
    );
  });
  it('business_settings: an absurdly long option list or block list is refused', async () => {
    const env = await getEnv();
    await seedBusinessSettings();
    await assertFails(
      asAuntie(env).firestore().doc('business_settings/business_settings')
        .set({ etaMinuteOptions: Array.from({ length: 13 }, (_, i) => i + 1) }, { merge: true }),
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

  // #891: recordFailedLogin's lock-spike record. Written only by the Admin SDK;
  // no rule matches it, so every client, the operator included, is denied.
  it('securitySignals: the lock-spike record is default-deny for every client', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('securitySignals/lockSpike').set({ locks: [{ uid: 'k1', ts: 1 }], updatedAtMs: 1 });
    });
    const auntie = asAuntie(env).firestore();
    await assertFails(auntie.doc('securitySignals/lockSpike').get());
    await assertFails(auntie.doc('securitySignals/lockSpike').set({ locks: [] }));
    await assertFails(env.unauthenticatedContext().firestore().doc('securitySignals/lockSpike').get());
    await assertFails(env.unauthenticatedContext().firestore().doc('securitySignals/lockSpike').set({ locks: [] }));
  });

  // #886: recordFailedLogin's per-address counter for addresses that are not
  // accounts. Operator reads for monitoring; no client may read or forge it.
  it('unknownLoginAttempts reads for the operator only and is never client-writable', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('unknownLoginAttempts/abc123').set({ attempts: [{ ts: 1 }], updatedAtMs: 1 });
    });
    const auntie = asAuntie(env).firestore();
    await assertSucceeds(auntie.doc('unknownLoginAttempts/abc123').get());
    await assertFails(auntie.doc('unknownLoginAttempts/abc123').set({ attempts: [] }));
    await assertFails(auntie.doc('unknownLoginAttempts/new').set({ attempts: [] }));
    await assertFails(env.unauthenticatedContext().firestore().doc('unknownLoginAttempts/abc123').get());
    await assertFails(env.unauthenticatedContext().firestore().doc('unknownLoginAttempts/abc123').set({ attempts: [] }));
  });

  it('the surviving rate-limit ledgers still read for the operator', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await db.doc('ipRateLimits/k1').set({ hits: 1 });
      await db.doc('securityRateLimits/k1').set({ hits: 1 });
      await db.doc('stripeEvents/evt_1').set({ seen: true });
      await db.doc('stripePayments/pi_1').set({ appliedEventId: 'evt_1' });
      await db.doc('stripeDisputes/dp_1').set({ disputeId: 'dp_1', status: 'needs_response' });
    });
    const fs = asAuntie(env).firestore();
    await assertSucceeds(fs.doc('ipRateLimits/k1').get());
    await assertSucceeds(fs.doc('securityRateLimits/k1').get());
    await assertSucceeds(fs.doc('stripeEvents/evt_1').get());
    await assertSucceeds(fs.doc('stripePayments/pi_1').get());
    await assertSucceeds(fs.doc('stripeDisputes/dp_1').get());
    await assertFails(fs.doc('ipRateLimits/k1').set({ hits: 0 }));
    // The per-PaymentIntent claim is server-written like its siblings: a client
    // that could forge one would suppress a real payment's ledger write.
    await assertFails(fs.doc('stripePayments/pi_2').set({ appliedEventId: 'x' }));
    // Same reasoning for the chargeback record, one step further: the invoice
    // deliberately keeps reading paid through a dispute, so this document is
    // the ONLY stored evidence that the money is contested. A client that could
    // write here could erase or fabricate that evidence.
    await assertFails(fs.doc('stripeDisputes/dp_2').set({ status: 'won' }));
    await assertFails(fs.doc('stripeDisputes/dp_1').update({ status: 'won' }));
  });

  // ── notifications: dead third branch dropped from both read gates ─────────
  // `isTestAdmin() && recipientUid == request.auth.uid` was a strict subset of
  // the `signedIn() && ...` branch above it (isTestAdmin implies auth), so it
  // could never decide. These pin that removing it changed no outcome: the
  // recipient branch already covers a test admin reading its own dispatch.
  //
  // ── R5, 2026-08-03: the channel subdocs moved ────────────────────────────
  // They used to hang off the INBOX document at
  // `notifications/{id}/channels/{channel}`, so per-channel delivery state was
  // structurally authorised beneath the thing an operator reads as mail. They
  // now sit under the work order at
  // `notificationDispatch/{id}/channels/{channel}`, and the fixture seeds both
  // documents because that is what the dispatcher now writes.
  //
  // The GATE is unchanged in effect: the same recipient sees the same things,
  // and nobody gained or lost visibility in the split. That is the property
  // these tests exist to hold. A refactor that quietly widened a read gate
  // would be a security change wearing a cleanup's clothes.

  async function seedNotification(recipientUid: string): Promise<void> {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await db.doc('notifications/n1').set({ recipientUid, key: 'kincare.requested' });
      await db
        .doc('notificationDispatch/n1')
        .set({ notificationId: 'n1', recipientUid, key: 'kincare.requested', status: 'dispatched' });
      await db.doc('notificationDispatch/n1/channels/email').set({ status: 'SENT' });
    });
  }

  it('notifications: the recipient reads their own dispatch and its channels', async () => {
    const env = await getEnv();
    await seedNotification('u-recipient');
    const fs = asUser(env, 'u-recipient').firestore();
    await assertSucceeds(fs.doc('notifications/n1').get());
    await assertSucceeds(fs.doc('notificationDispatch/n1').get());
    await assertSucceeds(fs.doc('notificationDispatch/n1/channels/email').get());
  });

  it('notifications: a test admin who IS the recipient still reads it (branch was redundant)', async () => {
    const env = await getEnv();
    await seedNotification('test-admin-uid');
    const fs = asTestAdmin(env).firestore();
    await assertSucceeds(fs.doc('notifications/n1').get());
    await assertSucceeds(fs.doc('notificationDispatch/n1/channels/email').get());
  });

  it('notifications: a test admin who is NOT the recipient is denied (as before)', async () => {
    const env = await getEnv();
    await seedNotification('someone-else');
    const fs = asTestAdmin(env).firestore();
    await assertFails(fs.doc('notifications/n1').get());
    await assertFails(fs.doc('notificationDispatch/n1').get());
    await assertFails(fs.doc('notificationDispatch/n1/channels/email').get());
  });

  it('notifications: a non-recipient is denied, the operator is not, nobody writes', async () => {
    const env = await getEnv();
    await seedNotification('u-recipient');
    await assertFails(asUser(env, 'u-other').firestore().doc('notifications/n1').get());
    await assertFails(asUser(env, 'u-other').firestore().doc('notificationDispatch/n1').get());
    await assertFails(
      asUser(env, 'u-other').firestore().doc('notificationDispatch/n1/channels/email').get(),
    );
    await assertSucceeds(asAuntie(env).firestore().doc('notifications/n1').get());
    await assertSucceeds(asAuntie(env).firestore().doc('notificationDispatch/n1').get());
    await assertFails(
      asUser(env, 'u-recipient').firestore().doc('notifications/n1').update({ read: true }),
    );
    // The work order is server-written too. A recipient who could stamp
    // `status: 'dispatched'` on their own would be able to suppress their own
    // delivery before the fan-out trigger ever saw it.
    await assertFails(
      asUser(env, 'u-recipient')
        .firestore()
        .doc('notificationDispatch/n1')
        .update({ status: 'dispatched' }),
    );
  });

  /**
   * The LEGACY shape is no longer readable by a client, and that is deliberate.
   *
   * Documents written before the split still carry `notifications/{id}/channels/*`
   * subdocs, and the rule that authorised them is gone. Nothing on any platform
   * ever queried them (the only reader was the Cloud Function trigger, and
   * Admin SDK writes bypass rules entirely), so closing them costs nothing and
   * removes the structural claim that delivery state belongs under an inbox
   * document. `mytribe/scripts/backfillNotificationDeliverySplit.ts` relocates
   * them onto the work order.
   */
  it('notifications: legacy channel subdocs under the inbox doc are closed to clients', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await db
        .doc('notifications/legacy1')
        .set({ recipientUid: 'u-recipient', key: 'kincare.requested' });
      await db.doc('notifications/legacy1/channels/email').set({ status: 'SENT' });
    });
    // The notification itself still reads, so no legacy inbox goes dark.
    await assertSucceeds(asUser(env, 'u-recipient').firestore().doc('notifications/legacy1').get());
    await assertFails(
      asUser(env, 'u-recipient').firestore().doc('notifications/legacy1/channels/email').get(),
    );
    await assertFails(asAuntie(env).firestore().doc('notifications/legacy1/channels/email').get());
  });

  /**
   * Punchlist B4: `vet_clinics` writes are CLOSED to every client.
   *
   * The rule was `write: if isAuntie()`, and under it both Kotlin trees edited
   * and hard-deleted clinics with a direct `.set()` / `.delete()`: no
   * validation, no check against the normalized-name dedupe `submitVetClinic`
   * enforces on create, and no audit entry, on a catalog shared with the
   * kinfolk portal. All three writes now have an admin-SDK callable
   * (submitVetClinic / updateVetClinic / archiveVetClinic), which bypasses
   * rules, so closing this is what makes those the ONLY paths rather than the
   * polite ones.
   */
  it('vet_clinics: an operator can READ the catalog', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('vet_clinics/vc1').set({ name: 'Riverside' });
    });
    await assertSucceeds(asAuntie(env).firestore().doc('vet_clinics/vc1').get());
  });
  it('vet_clinics: a kinfolk can READ the catalog, since the picker needs it', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('vet_clinics/vc1').set({ name: 'Riverside' });
    });
    await assertSucceeds(asUser(env, 'kin-1').firestore().doc('vet_clinics/vc1').get());
  });
  it('vet_clinics: even an OPERATOR cannot write directly any more', async () => {
    const env = await getEnv();
    await assertFails(asAuntie(env).firestore().doc('vet_clinics/vc2').set({ name: 'Sneaky' }));
  });
  it('vet_clinics: an operator cannot patch a clinic phone directly', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('vet_clinics/vc1').set({ name: 'Riverside', phone: '555' });
    });
    await assertFails(
      asAuntie(env).firestore().doc('vet_clinics/vc1').update({ phone: '999' }),
    );
  });
  /** The hard delete both Kotlin trees used to do. Refused at the rules layer. */
  it('vet_clinics: an operator cannot DELETE a clinic', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('vet_clinics/vc1').set({ name: 'Riverside' });
    });
    await assertFails(asAuntie(env).firestore().doc('vet_clinics/vc1').delete());
  });
  it('vet_clinics: a kinfolk cannot write, as before', async () => {
    const env = await getEnv();
    await assertFails(
      asUser(env, 'kin-1').firestore().doc('vet_clinics/vc3').set({ name: 'Nope' }),
    );
  });
  it('vet_clinics: a test admin cannot write either', async () => {
    const env = await getEnv();
    await assertFails(
      asTestAdmin(env).firestore().doc('vet_clinics/vc4').set({ name: 'Nope' }),
    );
  });

  // ── media_files.taggedKinIds is server-bound (#447) ────────────────────────
  //
  // Android used to patch this field straight from the client. The saveMediaTags
  // callable now owns it (admin SDK, which bypasses rules), so a client update
  // that TOUCHES the key must be refused however privileged the caller is, while
  // every other field on the doc keeps working exactly as before.

  async function seedMedia(env: Awaited<ReturnType<typeof getEnv>>, id: string) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`media_files/${id}`).set({
        kinfolkId: 'test-kinfolk-001',
        storageUrl: 'https://cdn/x.jpg',
        taggedKinIds: ['k1'],
      });
    });
  }

  it('media_files: an operator can still patch a NON-tag field', async () => {
    const env = await getEnv();
    await seedMedia(env, 'mf1');
    await assertSucceeds(
      asAuntie(env).firestore().doc('media_files/mf1').update({ description: 'Beach day' }),
    );
  });

  it('media_files: even an OPERATOR cannot write taggedKinIds directly', async () => {
    const env = await getEnv();
    await seedMedia(env, 'mf1');
    await assertFails(
      asAuntie(env).firestore().doc('media_files/mf1').update({ taggedKinIds: ['k1', 'k2'] }),
    );
  });

  it('media_files: an operator cannot CLEAR taggedKinIds directly either', async () => {
    const env = await getEnv();
    await seedMedia(env, 'mf1');
    await assertFails(
      asAuntie(env).firestore().doc('media_files/mf1').update({ taggedKinIds: [] }),
    );
  });

  it('media_files: a sandbox test admin cannot write taggedKinIds on its own doc', async () => {
    const env = await getEnv();
    await seedMedia(env, 'test-kinfolk-001-mf2');
    await assertFails(
      asTestAdmin(env)
        .firestore()
        .doc('media_files/test-kinfolk-001-mf2')
        .update({ taggedKinIds: ['k9'] }),
    );
  });

  it('media_files: a CREATE may still carry taggedKinIds (upload pipelines untouched)', async () => {
    const env = await getEnv();
    await assertSucceeds(
      asAuntie(env).firestore().doc('media_files/mf-new').set({
        kinfolkId: 'test-kinfolk-001',
        storageUrl: 'https://cdn/new.jpg',
        taggedKinIds: [],
      }),
    );
  });
});
