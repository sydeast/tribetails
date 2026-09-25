// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTemplateEditorSeed } from './useTemplateEditorSeed';
import { LOOP_CHANGED_ERROR, visualContentForSave } from './emailRoundTrip';

const LOOPED = '<p>Your visits:</p><ul>{{#each visits}}<li>{{this.date}}</li>{{/each}}</ul>';
const UNSUPPORTED = '<ul><li>a</li>{{#if vip}}<li>b</li>{{/if}}</ul>';

describe('useTemplateEditorSeed (#953)', () => {
  it('seeds from the row at open: mode, content and lock', () => {
    const { result } = renderHook(() => useTemplateEditorSeed({ format: 'visual', content: UNSUPPORTED }));
    expect(result.current.mode).toBe('visual');
    expect(result.current.seed).toEqual({ key: 0, content: UNSUPPORTED });
    expect(result.current.bodyLocked).toBe(true);
  });

  it('create mode is visual, empty and unlocked', () => {
    const { result } = renderHook(() => useTemplateEditorSeed(null));
    expect(result.current).toMatchObject({ mode: 'visual', seed: { key: 0, content: '' }, bodyLocked: false });
  });

  it('an old-format row is never locked (it has no visual body yet)', () => {
    const { result } = renderHook(() => useTemplateEditorSeed({ format: null, content: null }));
    expect(result.current).toMatchObject({ mode: 'old', bodyLocked: false });
  });

  it('reseed (Convert) switches to visual, remounts the editor and re-runs the lock on the new content', () => {
    const { result } = renderHook(() => useTemplateEditorSeed({ format: null, content: null }));
    act(() => result.current.reseed(UNSUPPORTED));
    expect(result.current).toMatchObject({ mode: 'visual', seed: { key: 1, content: UNSUPPORTED }, bodyLocked: true });
    act(() => result.current.reseed(LOOPED));
    expect(result.current).toMatchObject({ mode: 'visual', seed: { key: 2, content: LOOPED }, bodyLocked: false });
  });

  it('after a reseed the loop check measures against the new seed, not the old row', () => {
    // The row is old format with no content; Convert produced a looped list.
    const { result } = renderHook(() => useTemplateEditorSeed({ format: null, content: null }));
    act(() => result.current.reseed(LOOPED));
    const { seed, bodyLocked } = result.current;
    // Saving the converted content as it is, or with an edit inside the loop,
    // is not "removing a loop".
    expect(visualContentForSave(seed.content, LOOPED, bodyLocked)).toEqual({ content: LOOPED, error: null });
    const edited = LOOPED.replace('{{this.date}}', '{{this.date}} (booked)');
    expect(visualContentForSave(seed.content, edited, bodyLocked)).toEqual({ content: edited, error: null });
    // Dropping the loop the converted content carries is.
    expect(visualContentForSave(seed.content, '<p>Your visits:</p>', bodyLocked).error).toBe(LOOP_CHANGED_ERROR);
  });
});

describe('visualContentForSave', () => {
  it('a locked body sends the seed unchanged, whatever the editor holds', () => {
    expect(visualContentForSave(UNSUPPORTED, '<p>other</p>', true)).toEqual({ content: UNSUPPORTED, error: null });
  });

  it('an unlocked body sends the edit, refused when its loop count differs from the seed', () => {
    expect(visualContentForSave('', '<p>x</p>', false)).toEqual({ content: '<p>x</p>', error: null });
    expect(visualContentForSave(LOOPED, '<p>x</p>', false)).toEqual({ content: '<p>x</p>', error: LOOP_CHANGED_ERROR });
  });
});
