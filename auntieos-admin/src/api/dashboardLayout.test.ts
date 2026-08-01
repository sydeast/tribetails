import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
const { getDoc, doc } = vi.hoisted(() => ({ getDoc: vi.fn(), doc: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));
vi.mock('firebase/firestore', () => ({ getDoc, doc }));
vi.mock('../lib/firebase', () => ({ db: {} }));

import { getDashboardLayout, saveDashboardLayout } from './dashboardLayout';
import { DEFAULT_DASHBOARD, type DashWidget } from '../lib/dashboardLayout';

/** A Firestore snapshot shim: `exists()` plus `data()`. */
function snap(data: Record<string, unknown> | null) {
  return { exists: () => data !== null, data: () => data ?? undefined };
}

beforeEach(() => {
  call.mockReset();
  getDoc.mockReset();
  doc.mockReset();
  doc.mockReturnValue('doc-ref');
});

describe('getDashboardLayout', () => {
  it('reads the stored tokens off users/{uid} and resolves them to widgets', async () => {
    getDoc.mockResolvedValue(snap({ dashboardWidgets: ['safebox:wide', 'supplies:compact'] }));
    expect(await getDashboardLayout('op-1')).toEqual({
      widgets: [
        { key: 'safebox', size: 'wide' },
        { key: 'supplies', size: 'compact' },
      ],
      isStored: true,
    });
    expect(doc).toHaveBeenCalledWith({}, 'users', 'op-1');
  });

  it('reads a layout android wrote, unchanged, which is the whole point of one field', async () => {
    const androidTokens = ['stats:wide', 'cashFlow:wide', 'safebox:compact', 'supplies:compact'];
    getDoc.mockResolvedValue(snap({ dashboardWidgets: androidTokens }));
    const layout = await getDashboardLayout('op-1');
    expect(layout.widgets.map((x) => x.key)).toEqual(['stats', 'cashFlow', 'safebox', 'supplies']);
    expect(layout.isStored).toBe(true);
  });

  it('falls back to the shipped default for an operator who has never customized', async () => {
    getDoc.mockResolvedValue(snap({}));
    expect(await getDashboardLayout('op-1')).toEqual({
      widgets: [...DEFAULT_DASHBOARD],
      isStored: false,
    });
  });

  it('falls back to the shipped default when the user doc does not exist yet', async () => {
    getDoc.mockResolvedValue(snap(null));
    expect(await getDashboardLayout('op-1')).toEqual({
      widgets: [...DEFAULT_DASHBOARD],
      isStored: false,
    });
  });

  it('ignores non-string and non-array junk in the field rather than throwing on render', async () => {
    getDoc.mockResolvedValue(snap({ dashboardWidgets: 'stats:wide' }));
    expect(await getDashboardLayout('op-1')).toEqual({
      widgets: [...DEFAULT_DASHBOARD],
      isStored: false,
    });

    getDoc.mockResolvedValue(snap({ dashboardWidgets: [null, 7, 'safebox:wide', { a: 1 }] }));
    expect(await getDashboardLayout('op-1')).toEqual({
      widgets: [{ key: 'safebox', size: 'wide' }],
      isStored: true,
    });
  });

  it('rejects a blank uid instead of reading users/ with an empty id', async () => {
    await expect(getDashboardLayout('  ')).rejects.toThrow(/uid/i);
    expect(getDoc).not.toHaveBeenCalled();
  });

  it('propagates a read rejection so the screen can name it, never a silent default', async () => {
    getDoc.mockRejectedValue(new Error('permission-denied'));
    await expect(getDashboardLayout('op-1')).rejects.toThrow('permission-denied');
  });

  it('reports isStored: true even when the stored tokens happen to equal the shipped default', async () => {
    // THE CLOBBER BUG (C2). An operator can genuinely save exactly these three
    // widgets, in this exact order (android's board IS this literally, before
    // any customization). `widgets` alone is indistinguishable from "nothing
    // stored" in that case; `isStored` is the only signal a caller has to tell
    // the two apart, and it must say `true` here because a document write DID
    // happen. A caller that trusts VALUE equality instead (as `screens/Home.tsx`
    // used to) cannot tell a real, minimal, deliberately-saved layout from an
    // untouched one, and ends up substituting a display-only default over it.
    getDoc.mockResolvedValue(
      snap({ dashboardWidgets: ['stats:wide', 'todaysPack:compact', 'kintales:compact'] }),
    );
    expect(await getDashboardLayout('op-1')).toEqual({
      widgets: [...DEFAULT_DASHBOARD],
      isStored: true,
    });
  });
});

describe('saveDashboardLayout', () => {
  const layout: DashWidget[] = [
    { key: 'stats', size: 'wide' },
    { key: 'todaysPack', size: 'compact' },
  ];

  it('serializes the widgets to tokens and calls the deployed callable by name', async () => {
    call.mockResolvedValue({ ok: true, tokens: ['stats:wide', 'todaysPack:compact'] });
    await saveDashboardLayout(layout);
    expect(call).toHaveBeenCalledWith('saveDashboardLayout', {
      tokens: ['stats:wide', 'todaysPack:compact'],
    });
  });

  it('sends no uid: the callable writes the caller own doc, and a uid here would read as a target', async () => {
    call.mockResolvedValue({ ok: true, tokens: ['stats:wide', 'todaysPack:compact'] });
    await saveDashboardLayout(layout);
    expect(Object.keys(call.mock.calls[0]?.[1] ?? {})).toEqual(['tokens']);
  });

  it('returns the layout the SERVER echoed, not the one that was sent', async () => {
    // The server is the authority on what is stored. If the two ever disagree,
    // the operator must see what was actually saved.
    call.mockResolvedValue({ ok: true, tokens: ['stats:wide'] });
    expect(await saveDashboardLayout(layout)).toEqual([{ key: 'stats', size: 'wide' }]);
  });

  it('saves an empty layout as an empty token list', async () => {
    call.mockResolvedValue({ ok: true, tokens: [] });
    await saveDashboardLayout([]);
    expect(call).toHaveBeenCalledWith('saveDashboardLayout', { tokens: [] });
  });

  it('propagates a callable rejection unchanged so the arrangement is never silently dropped', async () => {
    call.mockRejectedValue(new Error('permission-denied'));
    await expect(saveDashboardLayout(layout)).rejects.toThrow('permission-denied');
  });

  it('throws when the callable answers without a token list, rather than reporting a save that may not have landed', async () => {
    call.mockResolvedValue({ ok: true });
    await expect(saveDashboardLayout(layout)).rejects.toThrow(/saveDashboardLayout/);
  });

  it('refuses to send more tokens than the callable accepts, naming the cap locally', async () => {
    const tooMany: DashWidget[] = Array.from({ length: 31 }, () => ({
      key: 'stats',
      size: 'wide',
    }));
    await expect(saveDashboardLayout(tooMany)).rejects.toThrow(/30/);
    expect(call).not.toHaveBeenCalled();
  });
});
