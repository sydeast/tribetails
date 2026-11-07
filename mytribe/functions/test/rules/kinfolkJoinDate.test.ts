import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown } from './setup';

/**
 * #1584. Operator ruling, 2026-11-05 docket: a household join date runs "from
 * the year the business started, 2025, up to today". The admin clients write
 * `kinfolk/{id}` directly, so these rules are the server path that holds it.
 */

function asAuntie(env: Awaited<ReturnType<typeof getEnv>>) {
  return env.authenticatedContext('staff-1', { admin: true });
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function seed(id: string, joinDate: string): Promise<void> {
  const env = await getEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(`kinfolk/${id}`).set({ firstName: 'Dre', lastName: 'East', joinDate });
  });
}

describe('rules: kinfolk joinDate (#1584)', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('refuses a join date in 1900', async () => {
    const env = await getEnv();
    await seed('k1', '2026-01-04');
    await assertFails(asAuntie(env).firestore().doc('kinfolk/k1').update({ joinDate: '1900-01-15' }));
  });

  it('refuses the last day of 2024', async () => {
    const env = await getEnv();
    await seed('k1', '2026-01-04');
    await assertFails(asAuntie(env).firestore().doc('kinfolk/k1').update({ joinDate: '2024-12-31' }));
  });

  it('refuses a join date in 2099', async () => {
    const env = await getEnv();
    await seed('k1', '2026-01-04');
    await assertFails(asAuntie(env).firestore().doc('kinfolk/k1').update({ joinDate: '2099-06-01' }));
  });

  it('refuses a date two days ahead', async () => {
    const env = await getEnv();
    await seed('k1', '2026-01-04');
    const ahead = isoDay(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000));
    await assertFails(asAuntie(env).firestore().doc('kinfolk/k1').update({ joinDate: ahead }));
  });

  it('refuses text that is not a day', async () => {
    const env = await getEnv();
    await seed('k1', '2026-01-04');
    await assertFails(asAuntie(env).firestore().doc('kinfolk/k1').update({ joinDate: '07/24/2026' }));
  });

  it('takes 2025-01-01, today and blank', async () => {
    const env = await getEnv();
    await seed('k1', '2026-01-04');
    const ref = asAuntie(env).firestore().doc('kinfolk/k1');
    await assertSucceeds(ref.update({ joinDate: '2025-01-01' }));
    await assertSucceeds(ref.update({ joinDate: isoDay(new Date()) }));
    await assertSucceeds(ref.update({ joinDate: '' }));
  });

  it('leaves an old out-of-range value editable when the write does not change it', async () => {
    const env = await getEnv();
    await seed('k1', '1900-01-15');
    await assertSucceeds(asAuntie(env).firestore().doc('kinfolk/k1').update({ gateCode: '1234' }));
  });
});
