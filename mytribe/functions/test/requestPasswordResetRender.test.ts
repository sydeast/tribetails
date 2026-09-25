import { describe, it, expect, vi } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #905: the reset email is only worth sending if its link survives rendering.
 *
 * Every other reset test fakes the transport. This one renders the repo's
 * `auth.password.reset` template through the REAL `renderEmailParts`, with a
 * link shaped like the Admin SDK's (`=`, `&` and `%` all present), and checks
 * the link arrives verbatim in both parts. Handlebars escapes `=` and `&` in the
 * html part unless `isSafeHtmlUrl` lets the value through (#892), and a link
 * mangled there is a dead link in the inbox.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));

import { loadResetTemplate } from '../src/auth/requestPasswordReset';
import { renderEmailParts } from '../src/lib/email';
import { sendPartsFor } from '../src/lib/emailFrame';

const LINK =
  'https://kinfolk.tribetails.com/account/secure-reset?mode=resetPassword&oobCode=abc-123_XYZ' +
  '&apiKey=AIzaTest&continueUrl=https%3A%2F%2Fkinfolk.tribetails.com%2Fsignin&lang=en';

describe('the repo reset template renders a working link', () => {
  it('falls back to the seed when nothing is stored, and the link survives both parts', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ writeThrough: true, docs: {} }).db);
    const { template, source } = await loadResetTemplate();
    expect(source).toBe('seed');
    // #953: the fallback is a visual document, not a pre-built body/html pair.
    expect(template).toMatchObject({ format: 'visual', headline: 'Reset your Tribe Tails password' });

    const out = renderEmailParts({
      ...sendPartsFor(template),
      data: { link: LINK, email: 'pat@household.test', displayName: 'Pat Doe' },
    });

    expect(out.subject).toBe('Reset your Tribe Tails password');
    expect(out.text).toContain(`Reset Password: ${LINK}`);
    expect(out.text).toContain('Pat Doe');
    // #953: the seed's button now comes through the sanitizer's canonical,
    // double-quoted attribute form (the pre-#953 hand-authored email.html used
    // single quotes for this button).
    expect(out.html).toContain(`href="${LINK}"`);
    expect(out.html).not.toContain('&amp;oobCode');
    expect(out.html).not.toMatch(/\{\{/);
  });
});
