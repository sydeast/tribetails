import { describe, it, expect } from 'vitest';
import { INBOX_SECTIONS, inboxSection, inboxUnreadTotal } from './inboxSections';

describe('INBOX_SECTIONS', () => {
  it('lists the Notifications digest before Messages (the archive stacking order)', () => {
    expect(INBOX_SECTIONS.map((s) => s.key)).toEqual(['notifications', 'messages']);
  });

  it('gives every section a title and a subtitle', () => {
    for (const s of INBOX_SECTIONS) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.subtitle.length).toBeGreaterThan(0);
    }
  });

  it('resolves a section definition by key', () => {
    expect(inboxSection('messages').title).toBe('Messages');
    expect(inboxSection('notifications').title).toBe('Notifications');
  });
});

describe('inboxUnreadTotal', () => {
  it('sums the unread counts across every resolved section', () => {
    expect(inboxUnreadTotal([2, 3])).toBe(5);
  });

  it('refuses a total while every section is still unresolved, rather than claiming 0', () => {
    expect(inboxUnreadTotal([null, null])).toBeNull();
  });

  it('reports a partial total when only some sections resolved', () => {
    expect(inboxUnreadTotal([null, 3])).toBe(3);
    expect(inboxUnreadTotal([4, null])).toBe(4);
  });

  it('reports a real 0 once resolved sections genuinely have nothing unread', () => {
    expect(inboxUnreadTotal([0, 0])).toBe(0);
    expect(inboxUnreadTotal([0, null])).toBe(0);
  });

  it('is null for no sections at all', () => {
    expect(inboxUnreadTotal([])).toBeNull();
  });

  it('scales past two sections, so Task 6.1 can add Channels without touching this', () => {
    expect(inboxUnreadTotal([1, 2, 3, null])).toBe(6);
  });
});
