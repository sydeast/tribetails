import { describe, it, expect, vi, beforeEach } from 'vitest';
const { call, deleteDoc, doc } = vi.hoisted(() => ({
  call: vi.fn(),
  deleteDoc: vi.fn(),
  doc: vi.fn((...args: unknown[]) => ({ __path: args.slice(1).join('/') })),
}));
vi.mock('../lib/fns', () => ({ call }));
vi.mock('../lib/firestoreWrite', () => ({ deleteDoc }));
vi.mock('firebase/firestore', () => ({ doc }));
vi.mock('../lib/firebase', () => ({ db: {} }));
import {
  getKinTaleTemplateUsage,
  removalImpact,
  removeKinTaleTemplate,
  type KinTaleTemplateUsage,
} from './kinTaleTemplateRemoval';
beforeEach(() => {
  call.mockReset();
  deleteDoc.mockReset();
});
function usage(over: Partial<KinTaleTemplateUsage> = {}): KinTaleTemplateUsage {
  return {
    templateId: 't1',
    exists: true,
    name: 'Dog walk recap',
    isDefault: false,
    isActive: true,
    kintaleCount: 0,
    otherActiveTemplateCount: 2,
    ...over,
  };
}
describe('kinTaleTemplateRemoval (#1591)', () => {
  it('getKinTaleTemplateUsage sends { templateId } to the callable and returns its answer', async () => {
    call.mockResolvedValue(usage({ kintaleCount: 4 }));
    const res = await getKinTaleTemplateUsage('t1');
    expect(call).toHaveBeenCalledWith('getKinTaleTemplateUsage', { templateId: 't1' });
    expect(res.kintaleCount).toBe(4);
  });
  it('removeKinTaleTemplate deletes kintale_templates/{id}', async () => {
    deleteDoc.mockResolvedValue(undefined);
    await removeKinTaleTemplate(' t1 ');
    expect(deleteDoc).toHaveBeenCalledWith({ __path: 'kintale_templates/t1' });
  });
  it('removeKinTaleTemplate refuses a blank id and writes nothing', async () => {
    await expect(removeKinTaleTemplate('  ')).rejects.toThrow(/template id is required/);
    expect(deleteDoc).not.toHaveBeenCalled();
  });
  it('removeKinTaleTemplate lets a Firestore rejection through unchanged', async () => {
    deleteDoc.mockRejectedValue(new Error('permission-denied'));
    await expect(removeKinTaleTemplate('t1')).rejects.toThrow('permission-denied');
  });
  it('removalImpact is empty when nothing depends on the template', () => {
    expect(removalImpact(usage())).toEqual([]);
  });
  it('removalImpact names the KinTales that use it, singular and plural', () => {
    expect(removalImpact(usage({ kintaleCount: 1 }))[0]).toMatch(/^1 KinTale was written from it/);
    expect(removalImpact(usage({ kintaleCount: 3 }))[0]).toMatch(/^3 KinTales were written from it/);
  });
  it('removalImpact says what losing the default means, with and without a fallback', () => {
    expect(removalImpact(usage({ isDefault: true }))[0]).toMatch(/default template/);
    expect(removalImpact(usage({ isDefault: true, otherActiveTemplateCount: 0 }))[0]).toMatch(
      /only active one/,
    );
  });
});
