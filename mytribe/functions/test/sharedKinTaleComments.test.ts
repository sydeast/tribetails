import { describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({
  comments: [] as Array<Record<string, unknown>>,
  docs: {} as Record<string, Record<string, unknown> | undefined>,
}));
vi.mock('../src/lib/firestoreAdmin', () => {
  const ref = (path: string) => ({
    path,
    get: async () => ({ data: () => state.docs[path] }),
  });
  return {
    db: () => ({
      collection: () => ({
        orderBy: () => ({
          limit: () => ({ get: async () => ({ docs: state.comments.map((c) => ({ data: () => c })) }) }),
        }),
      }),
      doc: ref,
      getAll: async (...refs: Array<{ path: string }>) =>
        refs.map((r) => ({ data: () => state.docs[r.path] })),
    }),
  };
});
import {
  toPublicComment,
  householdSignature,
  listPublicComments,
  ANONYMOUS_GUEST_NAME,
  FAMILY_NAME,
  AUNTIE_FALLBACK_NAME,
  staffSignature,
} from '../src/share/sharedKinTaleComments';

/**
 * ISSUE #624. The scrub that decides what a stranger holding a share link may
 * read off a household's comment thread.
 *
 * These are the tests that matter most in this change. The rendering can be
 * wrong and someone notices; the scrub can be wrong and nobody notices until a
 * uid or an email hash has been served on a public page for a month.
 */
describe('toPublicComment', () => {
  it('never carries a uid or an email hash through, whatever the document holds', () => {
    const scrubbed = toPublicComment({
      authorRole: 'guest',
      guestName: 'Marta',
      body: 'What a sweet pup.',
      createdAtMs: 1_780_000_000_000,
      // Fields a stored comment really does carry, and a guest must never see.
      ...({ guestEmailHash: 'ab12cd34', authorUid: 'uid-abc' } as Record<string, unknown>),
    });

    expect(scrubbed).not.toBeNull();
    // Asserted over the WHOLE object rather than field by field, so a future
    // field added to the DTO fails this instead of silently riding along.
    expect(Object.keys(scrubbed!).sort()).toEqual(['body', 'createdAtMs', 'fromGuest', 'name']);
    expect(JSON.stringify(scrubbed)).not.toContain('ab12cd34');
    expect(JSON.stringify(scrubbed)).not.toContain('uid-abc');
  });

  it("shows a guest's own name", () => {
    const scrubbed = toPublicComment({ authorRole: 'guest', guestName: 'Marta', body: 'hi' });
    expect(scrubbed?.name).toBe('Marta');
    expect(scrubbed?.fromGuest).toBe(true);
  });

  it('names an unnamed guest rather than printing an empty byline', () => {
    expect(toPublicComment({ authorRole: 'guest', guestName: '   ', body: 'hi' })?.name).toBe(
      ANONYMOUS_GUEST_NAME,
    );
    expect(toPublicComment({ authorRole: 'guest', guestName: null, body: 'hi' })?.name).toBe(
      ANONYMOUS_GUEST_NAME,
    );
  });

  it('never names a household member, whatever role or name the row carries', () => {
    // The household chose to send a recap, not to introduce their members to
    // whoever the link reached. A kinfolk comment is attributed to the family.
    for (const role of ['kinfolk', 'auntie', undefined]) {
      const scrubbed = toPublicComment({
        authorRole: role,
        guestName: 'Should Not Be Used',
        body: 'thanks!',
      });
      expect(scrubbed?.name).toBe(FAMILY_NAME);
      expect(scrubbed?.fromGuest).toBe(false);
    }
  });

  it('drops a row with no usable body rather than rendering an empty bubble', () => {
    expect(toPublicComment({ authorRole: 'guest', guestName: 'Marta', body: '' })).toBeNull();
    expect(toPublicComment({ authorRole: 'guest', guestName: 'Marta', body: '   ' })).toBeNull();
    expect(toPublicComment({ authorRole: 'guest', guestName: 'Marta' })).toBeNull();
  });

  it('passes the body through unescaped, because the renderer escapes it', () => {
    // Escaping here as well as at render time would double-encode and show the
    // entities to the reader. The renderer is the single place that escapes.
    const scrubbed = toPublicComment({
      authorRole: 'guest',
      guestName: 'Marta',
      body: '<script>alert(1)</script>',
    });
    expect(scrubbed?.body).toBe('<script>alert(1)</script>');
  });

  it('reports a missing clock as null rather than inventing one', () => {
    expect(toPublicComment({ authorRole: 'guest', guestName: 'M', body: 'hi' })?.createdAtMs).toBeNull();
    expect(
      toPublicComment({ authorRole: 'guest', guestName: 'M', body: 'hi', createdAtMs: 12 })
        ?.createdAtMs,
    ).toBe(12);
  });
});

describe('household signature (#1407)', () => {
  it('signs a two-part name with first name and last initial', () => {
    expect(householdSignature('Pat Rivera')).toBe('Pat R.');
    expect(householdSignature('  pat   rivera  ')).toBe('pat R.');
    expect(householdSignature('Mary Ann van der Berg')).toBe('Mary B.');
  });
  it('shows a single-token name alone', () => {
    expect(householdSignature('Pat')).toBe('Pat');
  });
  it('returns null for an empty or non-string name', () => {
    expect(householdSignature('   ')).toBeNull();
    expect(householdSignature(undefined)).toBeNull();
  });
  it('uses the resolved signature for a kinfolk comment and falls back to the family', () => {
    expect(toPublicComment({ authorRole: 'kinfolk', body: 'x' }, 'Pat R.')?.name).toBe('Pat R.');
    expect(toPublicComment({ authorRole: 'kinfolk', body: 'x' }, null)?.name).toBe(FAMILY_NAME);
  });
  it('never applies a household signature to a guest', () => {
    expect(toPublicComment({ authorRole: 'guest', guestName: 'Marta', body: 'x' }, 'Pat R.')?.name).toBe('Marta');
  });
  it('resolves the three name shapes end to end from the member record', async () => {
    state.docs = {
      'kin_care_reports/t1': { kinfolkId: 'k1' },
      'families/k1/members/u-two': { displayName: 'Pat Rivera' },
      'families/k1/members/u-one': { displayName: 'Sam' },
      'families/k1/members/u-empty': { displayName: '  ' },
    };
    state.comments = [
      { authorRole: 'kinfolk', authorUid: 'u-two', body: 'a', createdAtMs: 1 },
      { authorRole: 'kinfolk', authorUid: 'u-one', body: 'b', createdAtMs: 2 },
      { authorRole: 'kinfolk', authorUid: 'u-empty', body: 'c', createdAtMs: 3 },
    ];
    const out = await listPublicComments('t1');
    expect(out.map((c) => c.name)).toEqual(['Pat R.', 'Sam', FAMILY_NAME]);
    expect(JSON.stringify(out)).not.toContain('u-two');
    expect(JSON.stringify(out)).not.toContain('Rivera');
  });
});

describe('staff signature (#1416)', () => {
  it('prefixes the role word once, like the in-app thread', () => {
    expect(staffSignature('Maya')).toBe('Auntie Maya');
    expect(staffSignature('Auntie Maya')).toBe('Auntie Maya');
    expect(staffSignature('   ')).toBeNull();
    expect(staffSignature(undefined)).toBeNull();
  });
  it('falls back to a bare Auntie, never the family', () => {
    expect(toPublicComment({ authorRole: 'admin', body: 'x' }, null)?.name).toBe(AUNTIE_FALLBACK_NAME);
    expect(toPublicComment({ authorRole: 'admin', body: 'x' }, 'Auntie Maya')?.name).toBe('Auntie Maya');
  });
  it('signs named staff, unnamed staff, household and guest in one thread, with one batched read', async () => {
    state.docs = {
      'kin_care_reports/t2': { kinfolkId: 'k1' },
      'staff/s-named': { displayName: 'Maya', email: 'maya@example.invalid' },
      'staff/s-blank': { displayName: ' ' },
      'families/k1/members/u-two': { displayName: 'Pat Rivera' },
    };
    state.comments = [
      { authorRole: 'admin', authorUid: 's-named', body: 'a', createdAtMs: 1 },
      { authorRole: 'admin', authorUid: 's-blank', body: 'b', createdAtMs: 2 },
      { authorRole: 'admin', authorUid: 's-missing', body: 'c', createdAtMs: 3 },
      { authorRole: 'kinfolk', authorUid: 'u-two', body: 'd', createdAtMs: 4 },
      { authorRole: 'guest', guestName: 'Marta', body: 'e', createdAtMs: 5 },
      { authorRole: 'kinfolk', authorUid: 'u-none', body: 'f', createdAtMs: 6 },
    ];
    const out = await listPublicComments('t2');
    expect(out.map((c) => c.name)).toEqual([
      'Auntie Maya', 'Auntie', 'Auntie', 'Pat R.', 'Marta', FAMILY_NAME,
    ]);
    expect(out.map((c) => c.fromGuest)).toEqual([false, false, false, false, true, false]);
    for (const c of out) {
      expect(Object.keys(c).sort()).toEqual(['body', 'createdAtMs', 'fromGuest', 'name']);
    }
    const json = JSON.stringify(out);
    for (const secret of ['s-named', 'u-two', 'maya@example.invalid', 'Rivera']) {
      expect(json).not.toContain(secret);
    }
  });
});
