import { afterAll, afterEach, describe, it } from 'vitest';
import { assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, seedFamily, asUser } from './setup';

describe('rules: /families/{fid}/secrets/*', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('PRIMARY cannot read secrets/tribePin', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/secrets/tribePin').set({ hash: 'x' });
    });
    await assertFails(
      asUser(env, 'u-prim').firestore().doc('families/f1/secrets/tribePin').get(),
    );
  });

  it('PRIMARY cannot write secrets/tribePin', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await assertFails(
      asUser(env, 'u-prim').firestore().doc('families/f1/secrets/tribePin').set({ hash: 'y' }),
    );
  });
});
