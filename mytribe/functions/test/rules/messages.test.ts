import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, seedFamily, asUser } from './setup';

describe('rules: /families/{fid}/messages/{threadId}', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('SECONDARY w/ messaging_direct creates DIRECT thread incl. self', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: { messaging_direct: true } }],
    });
    await assertSucceeds(
      asUser(env, 'u-sec').firestore().doc('families/f1/messages/th-direct').set({
        kind: 'DIRECT',
        participantUids: ['u-sec', 'auntie-svc'],
        lastMessageAt: new Date(),
      }),
    );
  });

  it('SECONDARY without messaging_group cannot read GROUP thread', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/messages/th-group').set({
        kind: 'GROUP',
        participantUids: ['u-prim', 'u-sec', 'auntie-svc'],
        lastMessageAt: new Date(),
      });
    });
    await assertFails(
      asUser(env, 'u-sec').firestore().doc('families/f1/messages/th-group').get(),
    );
  });

  it('non-participant denied even if messaging_group=true', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: { messaging_group: true } }],
    });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/messages/th').set({
        kind: 'GROUP',
        participantUids: ['u-prim', 'auntie-svc'],
        lastMessageAt: new Date(),
      });
    });
    await assertFails(
      asUser(env, 'u-sec').firestore().doc('families/f1/messages/th').get(),
    );
  });
});
