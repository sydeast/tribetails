import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';
const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
import { getKinTaleTemplateUsageHandler } from '../src/admin/getKinTaleTemplateUsage';
beforeEach(() => mocks.dbFn.mockReset());
function req(data: unknown, uid: string | null = 'owner1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? { uid, token: { admin: true } as never } : undefined,
    rawRequest: {} as never,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}
function seed(opts: {
  templates?: Array<{ id: string; data: Record<string, unknown> }>;
  reports?: Array<{ id: string; data: Record<string, unknown> }>;
}) {
  const m = buildDbMock({
    docs: Object.fromEntries((opts.templates ?? []).map((t) => [`kintale_templates/${t.id}`, t.data])),
    queryDocs: { kintale_templates: opts.templates ?? [], kin_care_reports: opts.reports ?? [] },
  });
  mocks.dbFn.mockReturnValue(m.db);
}
describe('getKinTaleTemplateUsage (#1591)', () => {
  it('SAD: rejects an unauthenticated caller', async () => {
    seed({});
    await expect(getKinTaleTemplateUsageHandler(req({ templateId: 't1' }, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
  it('SAD: rejects a missing template id', async () => {
    seed({});
    await expect(getKinTaleTemplateUsageHandler(req({}))).rejects.toBeTruthy();
  });
  it('HAPPY: reports the template, how many KinTales use it and what is left to fall back on', async () => {
    seed({
      templates: [
        { id: 't1', data: { name: 'Dog walk recap', isDefault: true, isActive: true } },
        { id: 't2', data: { name: 'Cat visit', isDefault: false, isActive: true } },
        { id: 't3', data: { name: 'Old', isDefault: false, isActive: false } },
      ],
      reports: [
        { id: 'r1', data: { templateId: 't1' } },
        { id: 'r2', data: { templateId: 't1' } },
      ],
    });
    const res = await getKinTaleTemplateUsageHandler(req({ templateId: 't1' }));
    expect(res).toMatchObject({
      templateId: 't1',
      exists: true,
      name: 'Dog walk recap',
      isDefault: true,
      isActive: true,
      archived: false,
      kintaleCount: 2,
    });
    expect(res.otherActiveTemplateCount).toBe(1);
  });
  it('HAPPY: says when the template is archived, and never counts an archived one as a fallback', async () => {
    seed({
      templates: [
        { id: 't1', data: { name: 'Old walk', isActive: true, archived: true } },
        { id: 't2', data: { name: 'Cat visit', isActive: true, archived: true } },
        { id: 't3', data: { name: 'Drop-in', isActive: true } },
      ],
      reports: [{ id: 'r1', data: { templateId: 't1' } }],
    });
    const res = await getKinTaleTemplateUsageHandler(req({ templateId: 't1' }));
    expect(res).toMatchObject({ archived: true, kintaleCount: 1 });
    expect(res.otherActiveTemplateCount).toBe(1);
  });
  it('a template that is already gone says so instead of throwing', async () => {
    seed({});
    const res = await getKinTaleTemplateUsageHandler(req({ templateId: 'ghost' }));
    expect(res).toMatchObject({ templateId: 'ghost', exists: false, name: '', kintaleCount: 0 });
  });
});
