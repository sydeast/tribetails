// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { kinDepth, kinSearch, useKinRoute, type KinSearch } from './useKinRoute';

const { historyGo } = vi.hoisted(() => ({ historyGo: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ history: { go: historyGo } }) }));

/** A stand-in address bar: `go` writes the search the next render reads. */
function setup(initial: KinSearch = {}) {
  let search = initial;
  const go = vi.fn((next: KinSearch) => {
    search = next;
  });
  const hook = renderHook(() => useKinRoute(search.kin, search.kinView, go));
  const change = (next: { id: string; edit: boolean } | null) => {
    act(() => hook.result.current.onKinRouteChange(next));
    hook.rerender();
  };
  const browserMovedTo = (next: KinSearch) => {
    search = next;
    hook.rerender();
  };
  return { hook, go, change, browserMovedTo };
}

describe('useKinRoute (#1893)', () => {
  beforeEach(() => historyGo.mockReset());

  it('opening a Kin pushes an address of its own', () => {
    const { go, hook, change } = setup();
    change({ id: 'kin1', edit: false });
    expect(go).toHaveBeenCalledWith({ kin: 'kin1' }, false);
    expect(hook.result.current.routedKin).toEqual({ id: 'kin1', edit: false });
  });

  it('Edit kin pushes, and leaving it pops back to the Kin page', () => {
    const { go, change } = setup();
    change({ id: 'kin1', edit: false });
    change({ id: 'kin1', edit: true });
    expect(go).toHaveBeenLastCalledWith({ kin: 'kin1', kinView: 'edit' }, false);
    go.mockClear();
    change({ id: 'kin1', edit: false });
    expect(historyGo).toHaveBeenCalledWith(-1);
    expect(go).not.toHaveBeenCalled();
  });

  it('a reload on the Kin page reads the address, and closing it replaces', () => {
    const { go, hook, change } = setup({ kin: 'kin1' });
    expect(hook.result.current.routedKin).toEqual({ id: 'kin1', edit: false });
    change(null);
    expect(historyGo).not.toHaveBeenCalled();
    expect(go).toHaveBeenCalledWith({}, true);
  });

  it('a reload on Edit kin stays on the form', () => {
    const { hook } = setup({ kin: 'kin1', kinView: 'edit' });
    expect(hook.result.current.routedKin).toEqual({ id: 'kin1', edit: true });
  });

  it('browser Back is counted, so a later close never pops past the profile', () => {
    const { go, change, browserMovedTo } = setup();
    change({ id: 'kin1', edit: false });
    browserMovedTo({});
    change({ id: 'kin2', edit: false });
    change(null);
    expect(historyGo).toHaveBeenCalledTimes(1);
    expect(historyGo).toHaveBeenCalledWith(-1);
    expect(go).toHaveBeenCalledTimes(2);
  });

  it('the pure helpers agree on the address', () => {
    expect(kinDepth(undefined, 'edit')).toBe(0);
    expect(kinDepth('k', undefined)).toBe(1);
    expect(kinDepth('k', 'edit')).toBe(2);
    expect(kinSearch(null)).toEqual({});
    expect(kinSearch({ id: 'k', edit: true })).toEqual({ kin: 'k', kinView: 'edit' });
  });
});
