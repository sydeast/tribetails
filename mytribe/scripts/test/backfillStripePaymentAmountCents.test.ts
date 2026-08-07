import { describe, it, expect } from 'vitest';
import { parseArgs, planAmountCentsStamp } from '../backfillStripePaymentAmountCents';

describe('backfillStripePaymentAmountCents parseArgs', () => {
  it('defaults to dry-run', () => {
    const a = parseArgs([]);
    expect(a.mode).toBe('dry-run');
    expect(a.allowProd).toBe(false);
    expect(a.pageSize).toBe(300);
  });

  it('--allow-prod implies an apply run', () => {
    const a = parseArgs(['--allow-prod']);
    expect(a.mode).toBe('apply');
    expect(a.allowProd).toBe(true);
  });

  it('captures --project and --page-size', () => {
    const a = parseArgs(['--project', 'mytribe-test', '--page-size', '50']);
    expect(a.projectId).toBe('mytribe-test');
    expect(a.pageSize).toBe(50);
  });

  it('refuses a nonsense page size', () => {
    expect(() => parseArgs(['--page-size', '0'])).toThrow();
    expect(() => parseArgs(['--page-size', 'lots'])).toThrow();
  });

  it('throws on unknown args', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown arg/);
  });

  it('an explicit --dry-run always wins over --allow-prod, in EITHER flag order', () => {
    // The one flag whose entire purpose is proving a run is safe before it
    // touches money. `--allow-prod --dry-run` must stay a dry run just as
    // surely as `--dry-run --allow-prod` does — a bug here inverts the
    // safety default on the exact script this task exists to make safe.
    const allowThenDry = parseArgs(['--allow-prod', '--dry-run']);
    expect(allowThenDry.mode).toBe('dry-run');
    // allowProd still reports the flag was seen, even though it lost.
    expect(allowThenDry.allowProd).toBe(true);

    const dryThenAllow = parseArgs(['--dry-run', '--allow-prod']);
    expect(dryThenAllow.mode).toBe('dry-run');
    expect(dryThenAllow.allowProd).toBe(true);
  });

  it('--dry-run alone is a no-op on the already-default mode', () => {
    const a = parseArgs(['--dry-run']);
    expect(a.mode).toBe('dry-run');
    expect(a.allowProd).toBe(false);
  });
});

describe('backfillStripePaymentAmountCents planAmountCentsStamp: the 100x defect', () => {
  it('stamps invoice #1029 correctly: amount 13750 is ALREADY CENTS on a stripe-event row', () => {
    const d = planAmountCentsStamp({ amount: 13750, amountSource: 'stripe-event' });
    expect(d).toEqual({ action: 'stamp', amountCents: 13750, before: null });
  });

  it('stamps a local-invoice row as DOLLARS, the other branch stripeWebhook can take', () => {
    const d = planAmountCentsStamp({ amount: 30, amountSource: 'local-invoice' });
    expect(d).toEqual({ action: 'stamp', amountCents: 3000, before: null });
  });

  it('stamps a row with no amountSource at all as dollars — every recordPayment.ts row predating this field', () => {
    const d = planAmountCentsStamp({ amount: 45.5 });
    expect(d).toEqual({ action: 'stamp', amountCents: 4550, before: null });
  });

  it('reports the prior value in `before` when amountCents is present but invalid', () => {
    const d = planAmountCentsStamp({ amount: 30, amountSource: 'local-invoice', amountCents: -1 });
    expect(d).toEqual({ action: 'stamp', amountCents: 3000, before: -1 });
  });
});

describe('backfillStripePaymentAmountCents planAmountCentsStamp: IS IDEMPOTENT', () => {
  it('a stamped row plans already_correct on the second pass, and stamps nothing further', () => {
    const doc: Record<string, unknown> = { amount: 13750, amountSource: 'stripe-event' };
    const first = planAmountCentsStamp(doc);
    expect(first).toEqual({ action: 'stamp', amountCents: 13750, before: null });

    // Apply the planned write exactly as the script's batch.set would, then re-plan.
    const second = planAmountCentsStamp({ ...doc, amountCents: (first as { amountCents: number }).amountCents });
    expect(second).toEqual({ action: 'skip', reason: 'already_correct' });
  });

  it('running the plan twice does not re-scale an already-correct row (100x -> 10,000x guard)', () => {
    // If a non-idempotent version of this rule re-ran the stripe-event branch
    // on a row that ALREADY carries the correct amountCents, treating that
    // amountCents as though it were still the raw `amount` would multiply an
    // already-correct 13750 by 100 again. The `amountCents` guard at the top
    // of planAmountCentsStamp is what prevents that class of bug.
    const alreadyStamped = { amount: 13750, amountSource: 'stripe-event', amountCents: 13750 };
    expect(planAmountCentsStamp(alreadyStamped)).toEqual({ action: 'skip', reason: 'already_correct' });
    // A second and third plan agree: still skip, still 13750, never touched.
    expect(planAmountCentsStamp(alreadyStamped)).toEqual({ action: 'skip', reason: 'already_correct' });
  });

  it('skips a row PR29 already wrote amountCents onto directly (the modern-row case)', () => {
    expect(planAmountCentsStamp({ amount: 1, amountCents: 13750, amountSource: 'stripe-event' })).toEqual({
      action: 'skip',
      reason: 'already_correct',
    });
  });
});

describe('backfillStripePaymentAmountCents planAmountCentsStamp: fail loud, never guessed', () => {
  it('reports unresolved for an amountSource: "unresolved" row, and stamps nothing', () => {
    expect(planAmountCentsStamp({ amount: null, amountSource: 'unresolved' })).toEqual({
      action: 'skip',
      reason: 'unresolved',
    });
  });

  it('reports unresolved for a stripe-event row with no usable amount', () => {
    expect(planAmountCentsStamp({ amountSource: 'stripe-event' })).toEqual({
      action: 'skip',
      reason: 'unresolved',
    });
  });

  it('reports unresolved for a row with neither amountCents nor a numeric amount', () => {
    expect(planAmountCentsStamp({})).toEqual({ action: 'skip', reason: 'unresolved' });
  });

  it('never returns a "stamp" decision carrying a guessed amountCents for an unresolved row', () => {
    // A regression guard on the shape itself, not just the reason: an
    // unresolved row must come back as action:'skip', never as action:'stamp'
    // with a 0 tucked inside it.
    const d = planAmountCentsStamp({ amount: null, amountSource: 'unresolved' });
    expect(d.action).toBe('skip');
  });
});
