import { describe, it, expect } from 'vitest';
import { segmentSaveBlocker, broadcastBlocker, broadcastAudienceArgs } from './audienceSegmentEdit';

describe('segmentSaveBlocker', () => {
  it('asks for a name first, since the name is how it gets picked again', () => {
    expect(segmentSaveBlocker('  ', { kind: 'all' })).toBe('Name this segment first.');
  });

  it('refuses a status segment with nothing in it', () => {
    expect(segmentSaveBlocker('Actives', { kind: 'status', statuses: [] })).toBe('Choose at least one status.');
  });

  it('refuses a tag segment with nothing in it', () => {
    expect(segmentSaveBlocker('VIPs', { kind: 'tags', tags: [], tagMatch: 'any' })).toBe('Choose at least one tag.');
  });

  it('passes a named all-kinfolk segment', () => {
    expect(segmentSaveBlocker('Everyone', { kind: 'all' })).toBeNull();
  });
});

describe('broadcastBlocker', () => {
  it('asks for a channel first', () => {
    expect(broadcastBlocker([], 'Subject', 'Body')).toBe('Pick at least one channel.');
  });

  it('requires a subject for email, because the callable does', () => {
    expect(broadcastBlocker(['email'], '  ', 'Body')).toBe('Add a subject. It is the title for email and in-app.');
  });

  it('requires a subject for in-app too, because the callable does', () => {
    expect(broadcastBlocker(['inapp'], '', 'Body')).toBe('Add a subject. It is the title for email and in-app.');
  });

  it('does not require a subject for text or push, because the callable does not', () => {
    expect(broadcastBlocker(['sms'], '', 'Body')).toBeNull();
    expect(broadcastBlocker(['push'], '', 'Body')).toBeNull();
  });

  it('requires a body', () => {
    expect(broadcastBlocker(['sms'], '', '  ')).toBe('Write a message first.');
  });
});

describe('broadcastAudienceArgs', () => {
  it('sends a saved segment by id, with no criteria beside it', () => {
    expect(broadcastAudienceArgs('s1', { kind: 'all' })).toEqual({ segmentId: 's1' });
  });

  it('sends inline criteria when no segment is picked', () => {
    expect(broadcastAudienceArgs(null, { kind: 'status', statuses: ['active'] })).toEqual({
      criteria: { kind: 'status', statuses: ['active'] },
    });
  });

  it('sends neither when ad-hoc criteria are not yet valid, rather than silently broadcasting to everyone', () => {
    expect(broadcastAudienceArgs(null, null)).toBeNull();
  });
});
