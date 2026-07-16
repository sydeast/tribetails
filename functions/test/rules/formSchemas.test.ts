import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, asUser, asUnauth } from './setup';

/**
 * Rules for /formSchemas/{schemaId} — global authoring docs read by signed-in
 * kinfolk so MyTribe TribeScreen / KinScreen / AccountSettings can render
 * server-authored form definitions. Writes gated to AuntieOS admins.
 *
 * Defense-in-depth: saveFormSchema callable additionally enforces
 * isAuntieOperator allowlist server-side (admin claim alone is insufficient
 * to pass that gate, but is sufficient for direct Firestore writes).
 */

describe('rules: /formSchemas/{schemaId}', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('signed-in kinfolk can READ a schema', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('formSchemas/tribeProfile').set({
        id: 'tribeProfile',
        name: 'Tribe Profile',
        version: 1,
        sections: [],
      });
    });
    await assertSucceeds(
      asUser(env, 'u-kinfolk').firestore().doc('formSchemas/tribeProfile').get(),
    );
  });

  it('admin (token.admin=true) can READ a schema', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('formSchemas/tribeProfile').set({
        id: 'tribeProfile',
        name: 'Tribe Profile',
        version: 1,
        sections: [],
      });
    });
    const adminCtx = env.authenticatedContext('u-admin', { admin: true });
    await assertSucceeds(
      adminCtx.firestore().doc('formSchemas/tribeProfile').get(),
    );
  });

  it('unauthenticated READ is DENIED', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('formSchemas/tribeProfile').set({
        id: 'tribeProfile',
        name: 'X',
        version: 1,
        sections: [],
      });
    });
    await assertFails(
      asUnauth(env).firestore().doc('formSchemas/tribeProfile').get(),
    );
  });

  it('signed-in non-admin WRITE is DENIED (create)', async () => {
    const env = await getEnv();
    await assertFails(
      asUser(env, 'u-kinfolk').firestore().doc('formSchemas/tribeProfile').set({
        id: 'tribeProfile',
        name: 'Pwned',
        version: 1,
        sections: [],
      }),
    );
  });

  it('signed-in non-admin WRITE is DENIED (update)', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('formSchemas/tribeProfile').set({
        id: 'tribeProfile',
        name: 'X',
        version: 1,
        sections: [],
      });
    });
    await assertFails(
      asUser(env, 'u-kinfolk')
        .firestore()
        .doc('formSchemas/tribeProfile')
        .update({ name: 'Pwned' }),
    );
  });

  it('signed-in non-admin DELETE is DENIED', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('formSchemas/tribeProfile').set({
        id: 'tribeProfile',
        name: 'X',
        version: 1,
        sections: [],
      });
    });
    await assertFails(
      asUser(env, 'u-kinfolk').firestore().doc('formSchemas/tribeProfile').delete(),
    );
  });

  it('admin can CREATE a schema', async () => {
    const env = await getEnv();
    const adminCtx = env.authenticatedContext('u-admin', { admin: true });
    await assertSucceeds(
      adminCtx.firestore().doc('formSchemas/newSchema').set({
        id: 'newSchema',
        name: 'New',
        version: 1,
        sections: [],
      }),
    );
  });

  it('admin can UPDATE a schema', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('formSchemas/tribeProfile').set({
        id: 'tribeProfile',
        name: 'X',
        version: 1,
        sections: [],
      });
    });
    const adminCtx = env.authenticatedContext('u-admin', { admin: true });
    await assertSucceeds(
      adminCtx
        .firestore()
        .doc('formSchemas/tribeProfile')
        .update({ name: 'Renamed', version: 2 }),
    );
  });

  it('admin can DELETE a schema', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('formSchemas/tribeProfile').set({
        id: 'tribeProfile',
        name: 'X',
        version: 1,
        sections: [],
      });
    });
    const adminCtx = env.authenticatedContext('u-admin', { admin: true });
    await assertSucceeds(
      adminCtx.firestore().doc('formSchemas/tribeProfile').delete(),
    );
  });

  it('unauthenticated WRITE is DENIED', async () => {
    const env = await getEnv();
    await assertFails(
      asUnauth(env).firestore().doc('formSchemas/tribeProfile').set({
        id: 'tribeProfile',
        name: 'Pwned',
        version: 1,
        sections: [],
      }),
    );
  });
});
