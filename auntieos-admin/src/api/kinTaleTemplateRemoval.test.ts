import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call, deleteDoc, updateDoc, doc } = vi.hoisted(() => ({
  call: vi.fn(),
  deleteDoc: vi.fn(),
  updateDoc: vi.fn(),
  doc: vi.fn((...args: unknown[]) => ({ __path: args.slice(1).join('/') })),
}));
vi.mock('../lib/fns', () => ({ call }));
vi.mock('../lib/firestoreWrite', () => ({ deleteDoc, updateDoc }));
vi.mock('firebase/firestore', () => ({ doc }));
vi.mock('../lib/firebase', () => ({ db: {} }));

import {
  archiveImpact,
  deleteHeadline,
  getKinTaleTemplateUsage,
  removalImpact,
  removeKinTaleTemplate,
  restoreClearsDefault,
  type KinTaleTemplateUsage,
} from './kinTaleTemplateRemoval';

beforeEach(() => {
  call.mockReset();
  deleteDoc.mockReset().mockResolvedValue(undefined);
  updateDoc.mockReset().mockResolvedValue(undefined);
});

function usage(over: Partial<KinTaleTemplateUsage> = {}): KinTaleTemplateUsage {
  return {
    templateId: 't1',
    exists: true,
    name: 'Dog walk recap',
    isDefault: false,
    isActive: true,
    archived: true,
    kintaleCount: 0,
    otherActiveTemplateCount: 2,
    ...over,
  };
}

const NOW = () => new Date('2026-11-06T18:00:00.000Z');

/**
 * #1591 ruling, 2026-11-05 docket: "both". Remove archives (restorable),
 * delete for good only from inside the archive, with the usage-count warning.
 */
describe('kinTaleTemplateRemoval (#1591)', () => {
  it('getKinTaleTemplateUsage sends { templateId } to the callable and returns its answer', async () => {
    call.mockResolvedValue(usage({ kintaleCount: 4 }));
    const res = await getKinTaleTemplateUsage('t1');
    expect(call).toHaveBeenCalledWith('getKinTaleTemplateUsage', { templateId: 't1' });
    expect(res.kintaleCount).toBe(4);
  });

  it('archive keeps the doc and marks it archived', async () => {
    await removeKinTaleTemplate(' t1 ', 'archive', { now: NOW });
    expect(updateDoc).toHaveBeenCalledWith(
      { __path: 'kintale_templates/t1' },
      { archived: true, archivedAt: '2026-11-06T18:00:00.000Z', updatedAt: '2026-11-06T18:00:00.000Z' },
    );
    expect(deleteDoc).not.toHaveBeenCalled();
  });

  it('restore brings it back, and drops the default flag only when told to', async () => {
    await removeKinTaleTemplate('t1', 'restore', { now: NOW });
    expect(updateDoc).toHaveBeenLastCalledWith(
      { __path: 'kintale_templates/t1' },
      { archived: false, archivedAt: '', updatedAt: '2026-11-06T18:00:00.000Z' },
    );
    await removeKinTaleTemplate('t1', 'restore', { now: NOW, clearDefault: true });
    expect(updateDoc).toHaveBeenLastCalledWith(
      { __path: 'kintale_templates/t1' },
      { archived: false, archivedAt: '', updatedAt: '2026-11-06T18:00:00.000Z', isDefault: false },
    );
  });

  it('delete removes kintale_templates/{id}', async () => {
    await removeKinTaleTemplate('t1', 'delete');
    expect(deleteDoc).toHaveBeenCalledWith({ __path: 'kintale_templates/t1' });
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it('refuses a blank id and writes nothing', async () => {
    await expect(removeKinTaleTemplate('  ', 'archive')).rejects.toThrow(/template id is required/);
    expect(updateDoc).not.toHaveBeenCalled();
    expect(deleteDoc).not.toHaveBeenCalled();
  });

  it('lets a Firestore rejection through unchanged', async () => {
    deleteDoc.mockRejectedValue(new Error('permission-denied'));
    await expect(removeKinTaleTemplate('t1', 'delete')).rejects.toThrow('permission-denied');
  });

  it('the delete confirm leads with how many KinTales used the template', () => {
    expect(deleteHeadline(usage())).toBe('No KinTale was written from this template.');
    expect(deleteHeadline(usage({ kintaleCount: 1 }))).toBe('1 KinTale was written from this template.');
    expect(deleteHeadline(usage({ kintaleCount: 7 }))).toBe('7 KinTales were written from this template.');
  });

  it('removalImpact is empty when nothing depends on the template', () => {
    expect(removalImpact(usage())).toEqual([]);
  });

  it('#2058: removalImpact says sent KinTales keep their care tasks, once, without repeating the count', () => {
    expect(removalImpact(usage({ kintaleCount: 1 }))).toEqual(['KinTales already sent keep their care tasks.']);
    expect(removalImpact(usage({ kintaleCount: 3 }))).toEqual(['KinTales already sent keep their care tasks.']);
    expect(removalImpact(usage({ kintaleCount: 3 })).join(' ')).not.toMatch(/written from|template|feed/i);
  });

  it('archiveImpact says it is restorable, and what archiving the default means', () => {
    expect(archiveImpact({ isDefault: false }).join(' ')).toMatch(/restore it from the archive/);
    expect(archiveImpact({ isDefault: false })).toHaveLength(2);
    expect(archiveImpact({ isDefault: true }).join(' ')).toMatch(/default template/);
  });

  it('restoreClearsDefault only when another live template is now the default', () => {
    const me = { _id: 't1', isDefault: true };
    expect(restoreClearsDefault(me, [me, { _id: 't2', isDefault: false }])).toBe(false);
    expect(restoreClearsDefault(me, [me, { _id: 't2', isDefault: true }])).toBe(true);
    expect(restoreClearsDefault(me, [{ _id: 't2', isDefault: true, archived: true }])).toBe(false);
    expect(restoreClearsDefault({ _id: 't1', isDefault: false }, [{ _id: 't2', isDefault: true }])).toBe(false);
  });
});
