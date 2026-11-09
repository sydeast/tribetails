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

/**
 * #1593: a checklist item has to carry text. Checked on create, and on an
 * update only when the checklist itself changes, so an old template with a
 * blank item can still be archived. At most 60 items: the rules check the list
 * slot by slot.
 */
describe('rules: kintale_templates checklist items (#1593)', () => {
  afterEach(async () => cleanup());
  const owner = async () => (await getEnv()).authenticatedContext('u-owner', { admin: true }).firestore();
  const item = (text: unknown, key = 'k') => ({ key, text, scope: 'visit', required: false, order: 0, conditions: [] });
  const items = (n: number) => Array.from({ length: n }, (_, i) => item(`Item ${i + 1}`, `k${i}`));
  it('a template whose items all say something saves', async () => {
    await assertSucceeds(
      (await owner()).doc('kintale_templates/new1').set({ name: 'Walk', checklistItems: [item('Fresh water')] }),
    );
  });
  it('an empty, blank or non-text item is refused on create', async () => {
    for (const bad of ['', '   ', 42, null]) {
      await assertFails(
        (await owner())
          .doc('kintale_templates/new2')
          .set({ name: 'Walk', checklistItems: [item('Fresh water'), item(bad, 'b')] }),
      );
    }
    await assertFails((await owner()).doc('kintale_templates/new3').set({ name: 'Walk', checklistItems: [{ key: 'x' }] }));
  });
  it('an empty item is refused when an update changes the checklist', async () => {
    await seed({ checklistItems: [item('Fresh water')] });
    await assertFails(
      (await owner()).doc('kintale_templates/t1').set({ checklistItems: [item('Fresh water'), item('')] }, { merge: true }),
    );
    await assertSucceeds(
      (await owner())
        .doc('kintale_templates/t1')
        .set({ checklistItems: [item('Fresh water'), item('Meds given', 'm')] }, { merge: true }),
    );
  });
  it('a stored blank item does not block an update that leaves the checklist alone', async () => {
    await seed({ checklistItems: [item('')] });
    await assertSucceeds((await owner()).doc('kintale_templates/t1').update({ archived: true, archivedAt: 'x' }));
    await assertSucceeds((await owner()).doc('kintale_templates/t1').update({ name: 'Renamed' }));
  });
  it('every slot up to the 60th is checked, and 61 items are refused', async () => {
    await assertSucceeds((await owner()).doc('kintale_templates/n60').set({ name: 'Long', checklistItems: items(60) }));
    const blankLast = [...items(59), item(' ', 'last')];
    await assertFails((await owner()).doc('kintale_templates/n60b').set({ name: 'Long', checklistItems: blankLast }));
    await assertFails((await owner()).doc('kintale_templates/n61').set({ name: 'Long', checklistItems: items(61) }));
    await seed({ checklistItems: items(3) });
    await assertSucceeds((await owner()).doc('kintale_templates/t1').update({ checklistItems: items(60) }));
  });
  it('a template with no checklist, or an empty one, is not refused for it', async () => {
    await assertSucceeds((await owner()).doc('kintale_templates/n0').set({ name: 'No checklist' }));
    await assertSucceeds((await owner()).doc('kintale_templates/n00').set({ name: 'Empty', checklistItems: [] }));
  });
  it('an Auntie still may not write one, however good the checklist', async () => {
    const auntie = (await getEnv()).authenticatedContext('u-auntie', { staffRole: 'auntie' }).firestore();
    await assertFails(auntie.doc('kintale_templates/a1').set({ name: 'Walk', checklistItems: [item('Fresh water')] }));
  });
});
