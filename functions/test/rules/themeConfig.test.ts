import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, seedFamily, asUser } from './setup';

describe('rules: /families/{fid}/themeConfig', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('PRIMARY can update kinfolkOverrides only', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/themeConfig/active').set({
        brandTokens: {}, kinfolkOverrides: {},
      });
    });
    await assertSucceeds(
      asUser(env, 'u-prim').firestore().doc('families/f1/themeConfig/active').update({
        kinfolkOverrides: { layoutDensity: 'comfy' }, updatedAt: new Date(),
      }),
    );
  });

  it('PRIMARY cannot edit brandTokens', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/themeConfig/active').set({
        brandTokens: {}, kinfolkOverrides: {},
      });
    });
    await assertFails(
      asUser(env, 'u-prim').firestore().doc('families/f1/themeConfig/active').update({
        brandTokens: { primary: '#000' },
      }),
    );
  });
});
