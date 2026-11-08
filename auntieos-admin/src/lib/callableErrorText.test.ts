import { describe, expect, it } from 'vitest';
import { CALLABLE_FALLBACK_TEXT, failedToLead, plainCallableMessage } from './callableErrorText';

/** #1592: the walk's three examples, and what must survive the rule untouched. */
describe('plainCallableMessage', () => {
  it.each([
    ['functions/invalid-argument', 'updateInvoice validation failed [400]'],
    ['functions/invalid-argument', 'updateKinCareSession validation failed [400]'],
    ['invalid-argument', 'updateInvoice validation failed'],
    ['functions/invalid-argument', 'formSchema validation failed'],
  ])('turns %s "%s" into a sentence with no function name or status', (code, message) => {
    const plain = plainCallableMessage(code, message);
    expect(plain).toBe('Something in this form was not accepted. Check what you entered and try again.');
  });

  it('gives the bare "[400]" the walk saw on Add secondary a sentence', () => {
    expect(plainCallableMessage('functions/invalid-argument', ' [400]')).toBe(
      'Something in this form was not accepted. Check what you entered and try again.',
    );
  });

  it('answers the SDK stand-ins for a code by that code', () => {
    expect(plainCallableMessage('functions/internal', 'INTERNAL [500]')).toBe(CALLABLE_FALLBACK_TEXT);
    expect(plainCallableMessage('functions/internal', 'internal')).toBe(CALLABLE_FALLBACK_TEXT);
    expect(plainCallableMessage('functions/permission-denied', 'Backend error status: PERMISSION_DENIED [403]')).toBe(
      'Your account is not allowed to do this.',
    );
    expect(plainCallableMessage('functions/unavailable', 'unavailable')).toBe(
      'The server could not be reached. Try again in a moment.',
    );
    expect(plainCallableMessage('functions/weird', '')).toBe(CALLABLE_FALLBACK_TEXT);
  });

  it('keeps a sentence the server wrote for the operator, dropping only the status', () => {
    expect(plainCallableMessage('functions/failed-precondition', 'This invoice is already paid. [400]')).toBe(
      'This invoice is already paid.',
    );
  });

  it('keeps the machine tokens screens match on', () => {
    expect(plainCallableMessage('functions/failed-precondition', 'no_recipients [400]')).toBe('no_recipients');
    expect(plainCallableMessage('functions/failed-precondition', 'recipient_opted_out')).toBe('recipient_opted_out');
  });
});

describe('failedToLead', () => {
  it('reads the verb off a callable name and never shows the name', () => {
    expect(failedToLead('markInvoicePaid')).toBe('Could not save');
    expect(failedToLead('listBookings')).toBe('Could not load');
    expect(failedToLead('reviewAndSendDraftInvoice')).toBe('Could not send');
    expect(failedToLead('approve')).toBe('Could not approve');
    expect(failedToLead('reject')).toBe('Could not decline');
    expect(failedToLead('frobnicateThing')).toBe('That did not go through');
  });
});
