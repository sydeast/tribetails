import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, asUser } from './setup';

/**
 * Rules for /kintale_templates/{id}, #1591.
 *
 * Operator ruling, 2026-11-05 docket: "both". Remove moves a template to the
 * archive (an update setting `archived: true`); deleting for good happens only
 * from inside the archive. The rule makes that true for every client: the owner
 * may delete an archived template and nothing else. Removal stays owner-only.
 */

async function seed(data: Record<string, unknown>): Promise<void> {
  const env = await getEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc('kintale_templates/t1').set({ name: 'Walk recap', isActive: true, ...data });
  });
}

describe('rules: /kintale_templates/{id} (#1591)', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  const owner = async () => (await getEnv()).authenticatedContext('u-owner', { admin: true }).firestore();
  const auntie = async () =>
    (await getEnv()).authenticatedContext('u-auntie', { staffRole: 'auntie' }).firestore();

  it('the owner may archive a template (an update)', async () => {
    await seed({});
    await assertSucceeds((await owner()).doc('kintale_templates/t1').update({ archived: true, archivedAt: 'x' }));
  });

  it('the owner may restore an archived template', async () => {
    await seed({ archived: true });
    await assertSucceeds((await owner()).doc('kintale_templates/t1').update({ archived: false, archivedAt: '' }));
  });

  it('the owner may delete an ARCHIVED template', async () => {
    await seed({ archived: true });
    await assertSucceeds((await owner()).doc('kintale_templates/t1').delete());
  });

  it('the owner may NOT delete a template that was never archived', async () => {
    await seed({});
    await assertFails((await owner()).doc('kintale_templates/t1').delete());
  });

  it('the owner may NOT delete a restored template', async () => {
    await seed({ archived: false });
    await assertFails((await owner()).doc('kintale_templates/t1').delete());
  });

  it('an Auntie may neither archive nor delete', async () => {
    await seed({ archived: true });
    await assertFails((await auntie()).doc('kintale_templates/t1').update({ archived: false }));
    await assertFails((await auntie()).doc('kintale_templates/t1').delete());
  });

  it('a signed-in kinfolk may not delete one', async () => {
    await seed({ archived: true });
    await assertFails(asUser(await getEnv(), 'u-kinfolk').firestore().doc('kintale_templates/t1').delete());
  });
});
