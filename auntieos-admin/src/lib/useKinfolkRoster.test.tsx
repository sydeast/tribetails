// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Async } from './async';
import type { Kinfolk } from '../api/directory';
const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('./firestore', () => ({ useCollection }));
import { KINFOLK_QUERY, sortKinfolkRoster } from '../api/directory';
import { VET_CLINICS_QUERY, sortVetClinics } from '../api/vetClinics';
import { useKinfolkRoster } from './useKinfolkRoster';
import { useVetClinics } from './useVetClinics';
/**
 * #1565. Firestore's `orderBy` drops a document that lacks the sort field, so
 * the kinfolk listener pages by document id and the A to Z order is rebuilt on
 * the client. A record with no last name must reach every picker.
 */
const row = (over: Partial<Kinfolk> & { _id: string }): Kinfolk => over as Kinfolk;
describe('kinfolk roster query (#1565)', () => {
  it('does not order by a field a record can lack', () => {
    expect(KINFOLK_QUERY.order[0]).toBe('__name__');
    expect(VET_CLINICS_QUERY.order[0]).toBe('__name__');
  });
  it('keeps a record with no last name, and orders it by its first name', () => {
    const sorted = sortKinfolkRoster([
      row({ _id: 'c', firstName: 'Zed', lastName: 'Adams' }),
      row({ _id: 'a', firstName: 'No Lead' }),
      row({ _id: 'b', firstName: 'Ann', lastName: 'Young' }),
    ]);
    expect(sorted.map((k) => k._id)).toEqual(['c', 'a', 'b']);
  });
  it('keeps a record with no name at all, and is stable for equal names', () => {
    const sorted = sortKinfolkRoster([
      row({ _id: 'z', firstName: 'Sam', lastName: 'Lee' }),
      row({ _id: 'y', firstName: 'Sam', lastName: 'Lee' }),
      row({ _id: 'n' }),
    ]);
    expect(sorted.map((k) => k._id)).toEqual(['y', 'z', 'n']);
  });
  it('does not mutate its input', () => {
    const input = [row({ _id: 'b', lastName: 'B' }), row({ _id: 'a', lastName: 'A' })];
    sortKinfolkRoster(input);
    expect(input.map((k) => k._id)).toEqual(['b', 'a']);
  });
});
describe('useKinfolkRoster', () => {
  it('subscribes to KINFOLK_QUERY and hands back every record, sorted', () => {
    const state: Async<Kinfolk[]> = {
      status: 'ready',
      data: [row({ _id: 'b', firstName: 'Bo', lastName: 'Zane' }), row({ _id: 'a', firstName: 'No Lead' })],
    };
    useCollection.mockReturnValue(state);
    const { result } = renderHook(() => useKinfolkRoster());
    expect(useCollection).toHaveBeenCalledWith(KINFOLK_QUERY);
    expect(result.current.status === 'ready' && result.current.data.map((k) => k._id)).toEqual(['a', 'b']);
  });
  it('passes loading and error states through untouched', () => {
    useCollection.mockReturnValue({ status: 'loading' });
    expect(renderHook(() => useKinfolkRoster()).result.current).toEqual({ status: 'loading' });
    useCollection.mockReturnValue({ status: 'error', message: 'nope' });
    expect(renderHook(() => useKinfolkRoster()).result.current).toEqual({ status: 'error', message: 'nope' });
  });
});
describe('vet clinics (#1565)', () => {
  it('sorts A to Z and keeps a clinic with no name', () => {
    const sorted = sortVetClinics([
      { _id: 'b', name: 'Zoo Vet' },
      { _id: 'a' },
      { _id: 'c', name: 'Animal Care' },
    ]);
    expect(sorted.map((c) => c._id)).toEqual(['a', 'c', 'b']);
  });
  it('useVetClinics reads VET_CLINICS_QUERY and sorts', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [{ _id: 'b', name: 'B' }, { _id: 'a', name: 'A' }] });
    const { result } = renderHook(() => useVetClinics());
    expect(useCollection).toHaveBeenCalledWith(VET_CLINICS_QUERY);
    expect(result.current.status === 'ready' && result.current.data.map((c) => c._id)).toEqual(['a', 'b']);
  });
});
