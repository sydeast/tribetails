// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { previewHouseholdNotice } = vi.hoisted(() => ({ previewHouseholdNotice: vi.fn() }));
vi.mock('../api/visitNoticePreview', () => ({ previewHouseholdNotice }));

import { useHouseholdNoticePreview } from './useHouseholdNoticePreview';

/** #1838/#2027: the confirm's question to the server, and what it holds meanwhile. */
describe('useHouseholdNoticePreview', () => {
  beforeEach(() => {
    previewHouseholdNotice
      .mockReset()
      .mockResolvedValue({ willNotify: true, reason: null, name: 'Dre East', channels: ['email'] });
  });

  it('HAPPY: asks with the household, the key and the visit, and holds the answer', async () => {
    const { result } = renderHook(() => useHouseholdNoticePreview('kf1', 'kincare.booking.cancel', 's1'));
    expect(result.current).toEqual({ status: 'checking' });
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', name: 'Dre East' }));
    expect(previewHouseholdNotice).toHaveBeenCalledWith('kf1', 'kincare.booking.cancel', 's1');
  });

  it('NEGATIVE: a row naming no household asks by its visit alone', async () => {
    renderHook(() => useHouseholdNoticePreview('', 'kincare.changed', 's1'));
    await waitFor(() => expect(previewHouseholdNotice).toHaveBeenCalledWith('', 'kincare.changed', 's1'));
  });

  it('NEGATIVE: no household and no visit says nothing, never "checking" forever', async () => {
    const { result } = renderHook(() => useHouseholdNoticePreview('', 'kincare.note.auntie'));
    await waitFor(() => expect(result.current).toEqual({ status: 'unknown' }));
    expect(previewHouseholdNotice).not.toHaveBeenCalled();
  });

  it('ERROR: a failed call is unknown, so the confirm claims nothing', async () => {
    previewHouseholdNotice.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useHouseholdNoticePreview('kf1', 'kincare.booking.confirm'));
    await waitFor(() => expect(result.current).toEqual({ status: 'unknown' }));
  });

  it('closed (null) asks nothing', () => {
    const { result } = renderHook(() => useHouseholdNoticePreview(null, 'kincare.changed'));
    expect(result.current).toEqual({ status: 'checking' });
    expect(previewHouseholdNotice).not.toHaveBeenCalled();
  });
});
