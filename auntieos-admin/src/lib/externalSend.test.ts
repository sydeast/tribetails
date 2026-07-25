import { describe, it, expect } from 'vitest';
import {
  EXTERNAL_CHANNELS,
  isValidExternalEmail,
  isValidExternalPhone,
  validateExternalRecipient,
  externalSendBlocker,
  externalSuppressBlocker,
  isOptedOutError,
  externalSendErrorText,
} from './externalSend';

describe('EXTERNAL_CHANNELS', () => {
  it('offers the two channels the callable accepts, email first', () => {
    expect(EXTERNAL_CHANNELS).toEqual([
      { key: 'email', label: 'Email' },
      { key: 'sms', label: 'Text' },
    ]);
  });
});

describe('isValidExternalEmail', () => {
  it('accepts an ordinary address', () => {
    expect(isValidExternalEmail('dana@example.com')).toBe(true);
  });

  it('accepts around surrounding whitespace, since the send trims too', () => {
    expect(isValidExternalEmail('  dana@example.com  ')).toBe(true);
  });

  it('rejects an address with no dotted host, matching the server regex', () => {
    expect(isValidExternalEmail('dana@example')).toBe(false);
  });

  it('rejects an address with no @', () => {
    expect(isValidExternalEmail('dana.example.com')).toBe(false);
  });

  it('rejects an address with an inner space', () => {
    expect(isValidExternalEmail('da na@example.com')).toBe(false);
  });

  it('rejects empty', () => {
    expect(isValidExternalEmail('   ')).toBe(false);
  });
});

describe('isValidExternalPhone', () => {
  it('accepts a US number in E.164', () => {
    expect(isValidExternalPhone('+15125550123')).toBe(true);
  });

  it('accepts the punctuation operators actually type', () => {
    expect(isValidExternalPhone('+1 (512) 555-0123')).toBe(true);
  });

  it('accepts a UK number, which a ten-digits-only rule would wrongly reject', () => {
    expect(isValidExternalPhone('+447700900123')).toBe(true);
  });

  it('rejects a number too short to be dialable anywhere', () => {
    expect(isValidExternalPhone('555 1234')).toBe(false);
  });

  it('rejects a number longer than E.164 allows', () => {
    expect(isValidExternalPhone('+1234567890123456')).toBe(false);
  });

  it('rejects letters', () => {
    expect(isValidExternalPhone('+1 512 CALL NOW')).toBe(false);
  });

  it('rejects empty', () => {
    expect(isValidExternalPhone('  ')).toBe(false);
  });
});

describe('validateExternalRecipient', () => {
  it('reports empty as empty, not as a bad address', () => {
    expect(validateExternalRecipient('email', '  ')).toBe('empty');
    expect(validateExternalRecipient('sms', '')).toBe('empty');
  });

  it('names the channel-specific failure', () => {
    expect(validateExternalRecipient('email', 'nope')).toBe('bad-email');
    expect(validateExternalRecipient('sms', 'nope')).toBe('bad-phone');
  });

  it('passes a good one', () => {
    expect(validateExternalRecipient('email', 'dana@example.com')).toBe('valid');
    expect(validateExternalRecipient('sms', '+15125550123')).toBe('valid');
  });
});

describe('externalSendBlocker', () => {
  it('asks for a recipient first', () => {
    expect(externalSendBlocker('email', '', '', '')).toBe('Add a recipient first.');
  });

  it('names a bad email', () => {
    expect(externalSendBlocker('email', 'nope', 'Hi', 'Body')).toBe('That does not look like a valid email address.');
  });

  it('names a bad phone and says what is missing', () => {
    expect(externalSendBlocker('sms', '5551234', '', 'Body')).toBe(
      'That does not look like a valid phone number. Use the full number with country code.',
    );
  });

  it('requires a subject on email, the way the callable does', () => {
    expect(externalSendBlocker('email', 'dana@example.com', '  ', 'Body')).toBe('Email needs a subject.');
  });

  it('never requires a subject on a text, which has no subject line', () => {
    expect(externalSendBlocker('sms', '+15125550123', '', 'Body')).toBeNull();
  });

  it('requires a body', () => {
    expect(externalSendBlocker('sms', '+15125550123', '', '   ')).toBe('Write a message body first.');
  });

  it('passes a complete email', () => {
    expect(externalSendBlocker('email', 'dana@example.com', 'Hi', 'Body')).toBeNull();
  });
});

describe('externalSuppressBlocker', () => {
  it('asks for a recipient to opt out', () => {
    expect(externalSuppressBlocker('email', '')).toBe('Add a recipient to opt out first.');
  });

  it('validates the recipient the same way the send does', () => {
    expect(externalSuppressBlocker('email', 'nope')).toBe('That does not look like a valid email address.');
    expect(externalSuppressBlocker('sms', '5551234')).toBe(
      'That does not look like a valid phone number. Use the full number with country code.',
    );
  });

  it('never asks for a subject or a body, because an opt-out sends nothing', () => {
    expect(externalSuppressBlocker('email', 'dana@example.com')).toBeNull();
  });
});

describe('isOptedOutError', () => {
  it('recognises the bare sentinel', () => {
    expect(isOptedOutError('recipient_opted_out')).toBe(true);
  });

  it('recognises it inside the code prefix the SDK wraps it in', () => {
    expect(isOptedOutError('FAILED_PRECONDITION: recipient_opted_out')).toBe(true);
  });

  it('recognises it case-insensitively', () => {
    expect(isOptedOutError('Recipient_Opted_Out')).toBe(true);
  });

  it('does not fire on an unrelated failure', () => {
    expect(isOptedOutError('twilio 21610: unsubscribed recipient')).toBe(false);
  });
});

describe('externalSendErrorText', () => {
  it('replaces the sentinel with copy that says what happened and what to do', () => {
    expect(externalSendErrorText('FAILED_PRECONDITION: recipient_opted_out')).toBe(
      'This recipient has opted out. Nothing was sent. Remove their suppression before sending again.',
    );
  });

  it('passes every other failure through verbatim, so a provider error is never hidden', () => {
    expect(externalSendErrorText('smtp2go rejected the sender domain')).toBe('smtp2go rejected the sender domain');
  });

  it('falls back to a named message rather than an empty banner', () => {
    expect(externalSendErrorText('   ')).toBe('The send failed.');
  });
});
