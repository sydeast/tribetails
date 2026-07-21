import { describe, expect, it } from 'vitest';
import { validateKinTaleDraft, kinTaleSendBlocker } from './kinTaleDraftSchema';

const CLEAN = { title: 'Nova Meets the Door', bodyCopy: 'Nova met me at the door.', sessionId: 'sess1' };

describe('validateKinTaleDraft', () => {
  it('passes a clean draft', () => {
    expect(validateKinTaleDraft(CLEAN)).toEqual({});
  });

  it('passes a completely empty draft, because saving a blank draft is legal', () => {
    expect(validateKinTaleDraft({ title: '', bodyCopy: '', sessionId: '' })).toEqual({});
  });

  // Voice Bible section 11. The backend strips dashes from GENERATED copy, but
  // an operator typing one by hand should be told rather than silently rewritten.
  it('rejects an em dash in the headline and says what to use instead', () => {
    const errors = validateKinTaleDraft({ ...CLEAN, title: 'Nova — and Otis' });
    expect(errors.title).toMatch(/does not use dashes/i);
    expect(errors.title).toMatch(/ellipses/i);
  });

  it('rejects an en dash too, not just the em dash', () => {
    expect(validateKinTaleDraft({ ...CLEAN, title: 'Nova – and Otis' }).title).toBeDefined();
  });

  it('rejects a dash in the body', () => {
    expect(validateKinTaleDraft({ ...CLEAN, bodyCopy: 'She ate — then slept.' }).bodyCopy).toBeDefined();
  });

  it('accepts a plain hyphen, which is not a dash', () => {
    expect(validateKinTaleDraft({ ...CLEAN, title: 'A Well-Fed Cat' })).toEqual({});
  });

  it('rejects an over-long headline', () => {
    expect(validateKinTaleDraft({ ...CLEAN, title: 'x'.repeat(121) }).title).toMatch(/120/);
  });

  it('reports one message per field, not a stack', () => {
    const errors = validateKinTaleDraft({ title: `${'x'.repeat(121)}—`, bodyCopy: '', sessionId: '' });
    expect(Object.keys(errors)).toEqual(['title']);
  });
});

describe('kinTaleSendBlocker', () => {
  // A sessionless draft can be SAVED but never SENT: the send transition has to
  // reach the parent session doc to bump its counters.
  it('blocks a send with no linked visit, and says to save instead', () => {
    expect(kinTaleSendBlocker({ ...CLEAN, sessionId: '  ' })).toMatch(/save it as a draft/i);
  });

  it('allows a send with a linked visit', () => {
    expect(kinTaleSendBlocker(CLEAN)).toBeNull();
  });
});
