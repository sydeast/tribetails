import { describe, it, expect } from 'vitest';
import { emailDomain, isProtectedEmail, isReservedEmail } from '../lib/reservedEmailDomain';

describe('isReservedEmail (#1082)', () => {
  it.each([
    'test-admin+sandbox@tribetails.test',
    'e2e-claim-0715@tribetails.test',
    'demo+alpha@tribetails.test',
    'a@b.example',
    'a@b.invalid',
    'a@host.localhost',
    'a@printer.local',
    'a@example.com',
    'a@example.net',
    'a@example.org',
    'a@mail.example.com',
    'A@TRIBETAILS.TEST',
    'a@Example.COM',
    'a@tribetails.test.',
    'a@example.com..',
    '  a@x.test  ',
    'a@localhost',
  ])('%s is reserved', (email) => {
    expect(isReservedEmail(email)).toBe(true);
  });

  it.each([
    'e2e-admin@tribetails.com',
    'catch@hanasamku.com',
    'pawsome@hanasamku.com',
    'someone@gmail.com',
    'a@notexample.com',
    'a@example.com.au',
    'a@example.co',
    'a@testing.com',
    'a@test.com',
    'a@local.com',
    '',
    'no-at-sign.test',
    '@x.test',
    'a@',
    null,
    undefined,
    42,
  ])('%s is not reserved', (email) => {
    expect(isReservedEmail(email)).toBe(false);
  });

  it('reads the domain lower-cased with trailing dots removed', () => {
    expect(emailDomain('X@Mail.Example.COM.')).toBe('mail.example.com');
    expect(emailDomain('a@b@c.test')).toBe('c.test');
    expect(emailDomain('nope')).toBeNull();
  });
});

describe('isProtectedEmail (#1082)', () => {
  it.each(['e2e-admin@tribetails.com', 'catch@hanasamku.com', 'pawsome@hanasamku.com', 'CATCH@hanasamku.com', 'anyone@tribetails.com', 'x@mail.tribetails.com', 'x@tribetails.com.'])(
    '%s is protected',
    (email) => {
      expect(isProtectedEmail(email)).toBe(true);
    },
  );

  it.each(['other@hanasamku.com', 'x@tribetails.test', 'x@nottribetails.com', null])('%s is not protected', (email) => {
    expect(isProtectedEmail(email)).toBe(false);
  });
});
