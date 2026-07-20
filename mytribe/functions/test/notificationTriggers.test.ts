import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/firestoreAdmin', () => ({ db: vi.fn(), auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

/**
 * Smoke imports for the 3 new notification-firing triggers wired in audit
 * follow-up. Full body coverage lives in dispatcher fan-out tests + emulator
 * suite (out of scope for unit run).
 */
describe('notification triggers — module load smoke', () => {
  it('onBookingsWrite exports without throwing', async () => {
    const mod = await import('../src/triggers/onBookingsWrite');
    expect(mod.onBookingsWrite).toBeDefined();
  });

  it('onFamilyKinWrite exports without throwing', async () => {
    const mod = await import('../src/triggers/onFamilyKinWrite');
    expect(mod.onFamilyKinWrite).toBeDefined();
  });

  it('onFamilyProfileWrite exports without throwing', async () => {
    const mod = await import('../src/triggers/onFamilyProfileWrite');
    expect(mod.onFamilyProfileWrite).toBeDefined();
  });

  it('onInvoicesWrite exports without throwing', async () => {
    const mod = await import('../src/triggers/onInvoicesWrite');
    expect(mod.onInvoicesWrite).toBeDefined();
  });

  it('onKinTaleCreate (post catalog wire-up) exports without throwing', async () => {
    const mod = await import('../src/triggers/onKinTaleCreate');
    expect(mod.onKinTaleCreate).toBeDefined();
  });

  it('invoiceRemindersCron + invoiceOverdueCron export without throwing', async () => {
    const mod = await import('../src/scheduled/invoiceRemindersCron');
    expect(mod.invoiceRemindersCron).toBeDefined();
    expect(mod.invoiceOverdueCron).toBeDefined();
  });

  it('kincareReminderCron exports without throwing', async () => {
    const mod = await import('../src/scheduled/kincareReminderCron');
    expect(mod.kincareReminderCron).toBeDefined();
  });

  it('scheduleDigestCron exports without throwing', async () => {
    const mod = await import('../src/scheduled/scheduleDigestCron');
    expect(mod.scheduleDigestCron).toBeDefined();
  });

  it('scheduleMarketingBlast exports without throwing', async () => {
    const mod = await import('../src/admin/scheduleMarketingBlast');
    expect(mod.scheduleMarketingBlast).toBeDefined();
  });

  it('onKinTaleCommentCreate exports without throwing', async () => {
    const c = await import('../src/triggers/onKinTaleCommentCreate');
    expect(c.onKinTaleCommentCreate).toBeDefined();
  });

  it('onBookingNoteCreate exports without throwing', async () => {
    const mod = await import('../src/triggers/onBookingNoteCreate');
    expect(mod.onBookingNoteCreate).toBeDefined();
  });

  it('onRatingCreate exports without throwing', async () => {
    const mod = await import('../src/triggers/onRatingCreate');
    expect(mod.onRatingCreate).toBeDefined();
  });

  it('addInternalBookingNote exports without throwing', async () => {
    const mod = await import('../src/admin/addInternalBookingNote');
    expect(mod.addInternalBookingNote).toBeDefined();
  });
});
