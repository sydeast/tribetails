import { describe, it, expect } from 'vitest';
import type { Kinfolk } from '../api/directory';
import {
  PERSONALIZE_MESSAGE_TYPES,
  PERSONALIZE_TONES,
  PERSONALIZE_LENGTHS,
  DEFAULT_MESSAGE_TYPE,
  DEFAULT_TONE,
  DEFAULT_LENGTH,
  messageTypeDef,
  filterRecipients,
  generateBlocker,
  approveBlocker,
  buildGeneratePayload,
  draftSubtitle,
  type PersonalizeFormState,
} from './personalizeCompose';

function kf(over: Partial<Kinfolk> = {}): Kinfolk {
  return { _id: 'k1', firstName: 'Dana', lastName: 'Reyes', email: 'dana@example.com', phoneNumber: '+15125550123', ...over } as Kinfolk;
}

function form(over: Partial<PersonalizeFormState> = {}): PersonalizeFormState {
  return {
    messageType: 'visit_report',
    tone: 'warm',
    length: 'medium',
    subject: '',
    notes: 'Nova ate every bite and Otis finally used the new bed.',
    recipientId: 'k1',
    ...over,
  };
}

describe('the chip tables', () => {
  it('offers exactly the four archive message types, KinTale first', () => {
    expect(PERSONALIZE_MESSAGE_TYPES.map((t) => t.key)).toEqual(['visit_report', 'sms', 'email', 'blog_post']);
  });

  it('labels visit_report as KinTale report, this product’s term for the archive’s "Visit report"', () => {
    expect(PERSONALIZE_MESSAGE_TYPES.map((t) => t.label)).toEqual(['KinTale report', 'Text', 'Email', 'Blog']);
  });

  it('only Blog addresses nobody, so only Blog needs no recipient', () => {
    const noRecipient = PERSONALIZE_MESSAGE_TYPES.filter((t) => !t.needsRecipient).map((t) => t.key);
    expect(noRecipient).toEqual(['blog_post']);
  });

  it('marks the two types that can actually be delivered, and how', () => {
    expect(messageTypeDef('sms').deliverable).toBe('sms');
    expect(messageTypeDef('email').deliverable).toBe('email');
    expect(messageTypeDef('visit_report').deliverable).toBe(false);
    expect(messageTypeDef('blog_post').deliverable).toBe(false);
  });

  it('offers the archive tone set with lowercase wire keys', () => {
    expect(PERSONALIZE_TONES).toEqual([
      { key: 'warm', label: 'Warm' },
      { key: 'cheerful', label: 'Cheerful' },
      { key: 'professional', label: 'Professional' },
      { key: 'playful', label: 'Playful' },
    ]);
  });

  it('offers the archive length set with lowercase wire keys', () => {
    expect(PERSONALIZE_LENGTHS).toEqual([
      { key: 'short', label: 'Short' },
      { key: 'medium', label: 'Medium' },
      { key: 'long', label: 'Long' },
    ]);
  });

  it('defaults to the archive defaults', () => {
    expect(DEFAULT_MESSAGE_TYPE).toBe('visit_report');
    expect(DEFAULT_TONE).toBe('warm');
    expect(DEFAULT_LENGTH).toBe('medium');
  });

  it('falls back to the default type rather than throwing on an unknown key', () => {
    expect(messageTypeDef('social_post').key).toBe('visit_report');
  });
});

describe('filterRecipients', () => {
  const rows: Kinfolk[] = [
    kf({ _id: 'a', firstName: 'Zoe', lastName: 'Adams', email: 'zoe@a.com' }),
    kf({ _id: 'b', firstName: 'Dana', lastName: 'Reyes', email: 'dana@b.com' }),
    kf({ _id: 'c', firstName: 'Gone', lastName: 'Away', email: 'gone@c.com', status: 'archived' }),
  ];

  it('never offers an archived household', () => {
    expect(filterRecipients(rows, '').map((r) => r._id)).toEqual(['b', 'a']);
  });

  it('sorts by display name, not insertion order', () => {
    expect(filterRecipients(rows, '').map((r) => r.firstName)).toEqual(['Dana', 'Zoe']);
  });

  it('matches on name, case-insensitively', () => {
    expect(filterRecipients(rows, 'dANa').map((r) => r._id)).toEqual(['b']);
  });

  it('matches on email too, so a half-remembered address finds the household', () => {
    expect(filterRecipients(rows, '@a.com').map((r) => r._id)).toEqual(['a']);
  });

  it('returns nothing when nothing matches, never a silent fallback to everyone', () => {
    expect(filterRecipients(rows, 'nobody')).toEqual([]);
  });

  it('caps the rendered list', () => {
    const many = Array.from({ length: 60 }, (_, i) => kf({ _id: `k${i}`, firstName: `N${String(i).padStart(2, '0')}` }));
    expect(filterRecipients(many, '', 40)).toHaveLength(40);
  });
});

describe('generateBlocker', () => {
  it('asks for notes first, because that is what Auntie writes from', () => {
    expect(generateBlocker(form({ notes: '   ', recipientId: '' }))).toBe(
      'Add a few notes first so Auntie has something to write about.',
    );
  });

  it('asks for a recipient once notes exist', () => {
    expect(generateBlocker(form({ recipientId: '' }))).toBe('Pick a recipient for this message type first.');
  });

  it('never asks a Blog post for a recipient', () => {
    expect(generateBlocker(form({ messageType: 'blog_post', recipientId: '' }))).toBeNull();
  });

  it('passes a complete form', () => {
    expect(generateBlocker(form())).toBeNull();
  });
});

describe('approveBlocker', () => {
  it('refuses a draft the server never saved, since there is no doc to promote', () => {
    expect(approveBlocker(form(), kf(), null, 'some copy')).toBe(
      'This draft was not saved, so there is nothing to approve. Regenerate and try again.',
    );
  });

  it('refuses an empty body', () => {
    expect(approveBlocker(form(), kf(), 'd1', '   ')).toBe('The message is empty. Write something before approving.');
  });

  it('refuses an email with no subject, the way the send itself would', () => {
    expect(approveBlocker(form({ messageType: 'email' }), kf(), 'd1', 'copy')).toBe('Email needs a subject.');
  });

  it('refuses a text to a household with no phone number on file', () => {
    expect(approveBlocker(form({ messageType: 'sms' }), kf({ phoneNumber: '' }), 'd1', 'copy')).toBe(
      'Dana Reyes has no phone number on file. Add one in Directory before sending.',
    );
  });

  it('refuses an email to a household with no email on file', () => {
    expect(approveBlocker(form({ messageType: 'email', subject: 'Hi' }), kf({ email: '' }), 'd1', 'copy')).toBe(
      'Dana Reyes has no email address on file. Add one in Directory before sending.',
    );
  });

  it('lets a KinTale report through with no contact method, because approving it delivers nothing', () => {
    expect(approveBlocker(form(), kf({ email: '', phoneNumber: '' }), 'd1', 'copy')).toBeNull();
  });

  it('passes a deliverable email with a subject and an address', () => {
    expect(approveBlocker(form({ messageType: 'email', subject: 'Nova and Otis' }), kf(), 'd1', 'copy')).toBeNull();
  });
});

describe('buildGeneratePayload', () => {
  it('sends the resolved kinfolk id, so the server never has to fuzzy-match a name', () => {
    const p = buildGeneratePayload(form(), kf({ _id: 'real-id' }), null);
    expect(p.kinfolk_id).toBe('real-id');
    expect(p.recipient).toBe('Dana Reyes');
  });

  it('carries the tone and length chips under the wire names the function reads', () => {
    const p = buildGeneratePayload(form({ tone: 'playful', length: 'short' }), kf(), null);
    expect(p.tone_hint).toBe('playful');
    expect(p.max_length).toBe('short');
  });

  it('sends no recipient and no id for a Blog post', () => {
    const p = buildGeneratePayload(form({ messageType: 'blog_post', recipientId: '' }), undefined, null);
    expect(p.recipient).toBe('');
    expect('kinfolk_id' in p).toBe(false);
  });

  it('asks for a title only when there is a subject line to put one in', () => {
    expect(buildGeneratePayload(form({ messageType: 'email' }), kf(), null).want_title).toBe(true);
    expect('want_title' in buildGeneratePayload(form(), kf(), null)).toBe(false);
  });

  it('omits avoid_opening entirely on a first generate', () => {
    expect('avoid_opening' in buildGeneratePayload(form(), kf(), null)).toBe(false);
  });

  it('carries avoid_opening on a regenerate', () => {
    expect(buildGeneratePayload(form(), kf(), 'She had a big day.').avoid_opening).toBe('She had a big day.');
  });

  it('trims the notes rather than shipping the operator’s trailing whitespace to the model', () => {
    expect(buildGeneratePayload(form({ notes: '  two dogs  ' }), kf(), null).raw_notes).toBe('two dogs');
  });
});

describe('draftSubtitle', () => {
  it('names the pieces the archive named, joined the archive way', () => {
    expect(draftSubtitle({ kinfolk_name: 'Dana Reyes', communication_type: 'visit_report', model: 'claude-sonnet-4-5', draft_id: 'd7' })).toBe(
      'for Dana Reyes · visit_report · claude-sonnet-4-5 · draft #d7',
    );
  });

  it('drops the pieces that are missing instead of printing null', () => {
    expect(draftSubtitle({ kinfolk_name: null, communication_type: 'blog_post', model: null, draft_id: null })).toBe('blog_post');
  });
});
