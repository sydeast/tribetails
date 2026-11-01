import { describe, expect, it } from 'vitest';
import { INVALID_INVITE_EMAIL_MESSAGE, inviteEmailProblem, isInvitableEmail } from './inviteEmail';
describe('#1326 invite email check', () => {
  it('accepts real addresses, trimmed and in any case', () => {
    expect(isInvitableEmail('catch@hanasamku.com')).toBe(true);
    expect(isInvitableEmail('  Pawsome@Hanasamku.COM ')).toBe(true);
  });
  it('refuses what the QA walk typed, and what the server would refuse', () => {
    for (const bad of ['bad-email', 'catch@', '@hanasamku.com', 'catch@hanasamku', 'catch @hanasamku.com', 'catch@hanasamku..com']) {
      expect(isInvitableEmail(bad)).toBe(false);
    }
  });
  it('says why only once something is typed', () => {
    expect(inviteEmailProblem('')).toBeNull();
    expect(inviteEmailProblem('   ')).toBeNull();
    expect(inviteEmailProblem('catch@hanasamku.com')).toBeNull();
    expect(inviteEmailProblem('bad-email')).toBe(INVALID_INVITE_EMAIL_MESSAGE);
  });
});
