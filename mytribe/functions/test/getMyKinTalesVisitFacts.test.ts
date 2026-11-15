import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { buildCareTaskStamp } from '../src/lib/careTaskStamp';

/**
 * #2056: a KinTale in the household feed says which KinCare, which day and
 * which Kin it is about, and a care task ticked for one Kin names that Kin.
 *
 * Every field is optional on the wire. A tale sent before these existed, or one
 * with no visit behind it, has to come back exactly as it did before.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

const SENT_AT = '2026-11-10T22:13:20.000Z';
const FOUR_KIN = [
  { id: 'k1', data: { name: 'Biscuit' } },
  { id: 'k2', data: { name: 'Mochi' } },
  { id: 'k3', data: { name: 'Pip' } },
  { id: 'k4', data: { name: 'Tux' } },
];

function tale(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    data: { kinfolkId: 'fam3', bodyCopy: 'a story', mediaFileIds: [], sentAt: SENT_AT, sharedAsIds: [], ...extra },
  };
}

async function load(ctx: ReturnType<typeof buildDbMock>) {
  mocks.dbFn.mockReturnValue(ctx.db);
  const { getMyKinTalesHandler } = await import('../src/portal/getMyKinTales');
  return getMyKinTalesHandler({ data: { kinfolkId: 'fam3', limit: 50 }, auth: { uid: 'u1' } } as any);
}

function fedForOneKinAndLightsOff() {
  return {
    'k1|fed': { fieldKey: 'fed', kinId: 'k1', boolValue: true },
    '|lights_off': { fieldKey: 'lights_off', kinId: '', boolValue: true },
  };
}

describe('getMyKinTales: what the tale is about (#2056)', () => {
  it('a sent tale names its KinCare, its visit day and its Kin, and "Fed" names the one Kin it was ticked for', async () => {
    const fieldResponses = fedForOneKinAndLightsOff();
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'kin_care_sessions/s1': {
          serviceType: '30 Minute Quick Check',
          startTime: '2026-11-10T15:00:00.000Z',
          arrivedAt: '2026-11-10T15:02:00.000Z',
          kinIds: ['k1', 'k2', 'k3', 'k4'],
        },
      },
      queryDocs: {
        kin_care_reports: [
          tale('r1', {
            sessionId: 's1',
            kinIds: ['k1', 'k2', 'k3', 'k4'],
            fieldResponses,
            careTasks: buildCareTaskStamp({ templateId: '', template: null, fieldResponses, now: SENT_AT, by: 'send' }),
          }),
        ],
        'families/fam3/kin': FOUR_KIN,
      },
    });

    const res = await load(ctx);
    const t = res.tales[0]!;

    expect(t.serviceLabel).toBe('30 Minute Quick Check');
    expect(t.visitDate).toBe('2026-11-10');
    expect(t.kinNames).toEqual(['Biscuit', 'Mochi', 'Pip', 'Tux']);
    expect(t.checklist).toEqual([
      { key: 'fed', text: 'Fed', kinNames: ['Biscuit'] },
      { key: 'lights_off', text: 'Lights turned off' },
    ]);
  });

  it('a task ticked for two of four Kin names both, once each', async () => {
    const fieldResponses = {
      'k1|fed': { fieldKey: 'fed', kinId: 'k1', boolValue: true },
      'k3|fed': { fieldKey: 'fed', kinId: 'k3', boolValue: true },
      'k2|fed': { fieldKey: 'fed', kinId: 'k2', boolValue: false },
    };
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: {
        kin_care_reports: [
          tale('r1', {
            kinIds: ['k1', 'k2', 'k3', 'k4'],
            fieldResponses,
            careTasks: buildCareTaskStamp({ templateId: '', template: null, fieldResponses, now: SENT_AT, by: 'send' }),
          }),
        ],
        'families/fam3/kin': FOUR_KIN,
      },
    });

    const res = await load(ctx);

    expect(res.tales[0]!.checklist).toEqual([{ key: 'fed', text: 'Fed', kinNames: ['Biscuit', 'Pip'] }]);
  });

  it('a tale sent before the copy existed still names the Kin, from its own answers', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: {
        kin_care_reports: [tale('r1', { kinIds: ['k1', 'k2'], fieldResponses: fedForOneKinAndLightsOff() })],
        'families/fam3/kin': FOUR_KIN,
      },
    });

    const res = await load(ctx);

    expect(res.tales[0]!.kinNames).toEqual(['Biscuit', 'Mochi']);
    expect(res.tales[0]!.checklist).toEqual([
      { key: 'fed', text: 'Fed', kinNames: ['Biscuit'] },
      { key: 'lights_off', text: 'Lights turned off' },
    ]);
  });

  it('a once-per-visit task is never pinned on a Kin, even when its tick carries one', async () => {
    const fieldResponses = { 'k1|lights_off': { fieldKey: 'lights_off', kinId: 'k1', boolValue: true } };
    const stamped = tale('r1', {
      kinIds: ['k1'],
      fieldResponses,
      careTasks: buildCareTaskStamp({ templateId: '', template: null, fieldResponses, now: SENT_AT, by: 'send' }),
    });
    const legacy = tale('r2', { kinIds: ['k1'], fieldResponses, sentAt: '2026-11-09T22:13:20.000Z' });
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: { kin_care_reports: [stamped, legacy], 'families/fam3/kin': FOUR_KIN },
    });

    const res = await load(ctx);

    expect(res.tales[0]!.checklist).toEqual([{ key: 'lights_off', text: 'Lights turned off' }]);
    expect(res.tales[1]!.checklist).toEqual([{ key: 'lights_off', text: 'Lights turned off' }]);
  });

  it('the visit day is the business day: 10:30 PM Chicago on the 10th is the 10th, not the UTC 11th', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'kin_care_sessions/late': { startTime: '2026-11-11T04:30:00.000Z' },
        'kin_care_sessions/wall': { startTime: '2026-11-10T22:30:00' },
      },
      queryDocs: {
        kin_care_reports: [
          tale('r1', { sessionId: 'late' }),
          tale('r2', { sessionId: 'wall', sentAt: '2026-11-09T22:13:20.000Z' }),
        ],
      },
    });

    const res = await load(ctx);

    expect(res.tales[0]!.visitDate).toBe('2026-11-10');
    expect(res.tales[1]!.visitDate).toBe('2026-11-10');
  });

  it('with no session to read, the day and KinCare come from the tale itself', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: {
        kin_care_reports: [
          tale('r1', { sessionId: 'gone', serviceType: 'Overnight Stay', visitDate: '2026-11-08T18:00:00.000Z' }),
        ],
      },
    });

    const res = await load(ctx);

    expect(res.tales[0]!.serviceLabel).toBe('Overnight Stay');
    expect(res.tales[0]!.visitDate).toBe('2026-11-08');
  });

  it('a stored day with no time is that day, not the evening before', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: { kin_care_reports: [tale('r1', { visitDate: '2026-11-10' })] },
    });
    const res = await load(ctx);
    expect(res.tales[0]!.visitDate).toBe('2026-11-10');
  });
  it('an old tale with none of this comes back as it always did, and costs no extra read', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: { kin_care_reports: [tale('r1')] },
    });
    const realCollection = ctx.db.collection;
    ctx.db.collection = vi.fn((path: string) => realCollection(path)) as typeof ctx.db.collection;

    const res = await load(ctx);
    const t = res.tales[0]! as unknown as Record<string, unknown>;

    expect('serviceLabel' in t).toBe(false);
    expect('visitDate' in t).toBe(false);
    expect('kinNames' in t).toBe(false);
    expect('checklist' in t).toBe(false);
    expect(JSON.stringify(res)).not.toContain('undefined');
    expect(ctx.db.collection).not.toHaveBeenCalledWith('families/fam3/kin');
    expect(ctx.db.getAll).not.toHaveBeenCalled();
  });

  it('a service code and free-text date are left out, never printed', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: { kin_care_reports: [tale('r1', { serviceType: 'visit_60', visitDate: 'March 3' })] },
    });

    const res = await load(ctx);

    expect(res.tales[0]!.serviceLabel).toBeUndefined();
    expect(res.tales[0]!.visitDate).toBeUndefined();
  });

  it('a Kin since removed is named from the visit when the visit kept every name', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'kin_care_sessions/s1': { kinIds: ['k1', 'gone'], kinNames: ['Biscuit', 'Juniper'] },
      },
      queryDocs: {
        kin_care_reports: [tale('r1', { sessionId: 's1', kinIds: ['k1', 'gone'] })],
        'families/fam3/kin': [{ id: 'k1', data: { name: 'Biscuit' } }],
      },
    });

    const res = await load(ctx);

    expect(res.tales[0]!.kinNames).toEqual(['Biscuit', 'Juniper']);
  });

  it('a Kin nobody can name is left out: no id reaches the household', async () => {
    const fieldResponses = { 'kin-id-9f3|fed': { fieldKey: 'fed', kinId: 'kin-id-9f3', boolValue: true } };
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        // Shorter than kinIds, so the pairing cannot be trusted by position.
        'kin_care_sessions/s1': { kinIds: ['kin-id-9f3', 'k1'], kinNames: ['Biscuit'] },
      },
      queryDocs: {
        kin_care_reports: [
          tale('r1', {
            sessionId: 's1',
            kinIds: ['kin-id-9f3', 'k1'],
            fieldResponses,
            careTasks: buildCareTaskStamp({ templateId: '', template: null, fieldResponses, now: SENT_AT, by: 'send' }),
          }),
        ],
        'families/fam3/kin': [{ id: 'k1', data: { name: 'Biscuit' } }],
      },
    });

    const res = await load(ctx);

    expect(res.tales[0]!.kinNames).toEqual(['Biscuit']);
    expect(res.tales[0]!.checklist).toEqual([{ key: 'fed', text: 'Fed' }]);
    expect(JSON.stringify(res)).not.toContain('kin-id-9f3');
  });

  it('a Kin the household added in MyTribe is named on a visit booked under its office id', async () => {
    // The household copy is `famKin9`; the admin app books and ticks under the
    // office record's id, which the household copy carries as `legacyKinId`.
    const fieldResponses = { 'office9|fed': { fieldKey: 'fed', kinId: 'office9', boolValue: true } };
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        // The visit's own names came back short, so the pairing is not trusted.
        'kin_care_sessions/s1': { kinfolkId: 'fam3', kinIds: ['k1', 'office9'], kinNames: ['Biscuit'] },
      },
      queryDocs: {
        kin_care_reports: [
          tale('r1', {
            sessionId: 's1',
            kinIds: ['k1', 'office9'],
            fieldResponses,
            careTasks: buildCareTaskStamp({ templateId: '', template: null, fieldResponses, now: SENT_AT, by: 'send' }),
          }),
        ],
        'families/fam3/kin': [
          { id: 'k1', data: { name: 'Biscuit', legacyKinId: 'k1' } },
          { id: 'famKin9', data: { name: 'Tux', legacyKinId: 'office9' } },
        ],
      },
    });
    const res = await load(ctx);
    expect(res.tales[0]!.kinNames).toEqual(['Biscuit', 'Tux']);
    expect(res.tales[0]!.checklist).toEqual([{ key: 'fed', text: 'Fed', kinNames: ['Tux'] }]);
    expect(JSON.stringify(res)).not.toContain('office9');
  });
  it('an office id two Kin of different names both claim names neither', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: {
        kin_care_reports: [tale('r1', { kinIds: ['k1', 'office9'] })],
        'families/fam3/kin': [
          { id: 'k1', data: { name: 'Biscuit' } },
          { id: 'a', data: { name: 'Tux', legacyKinId: 'office9' } },
          { id: 'b', data: { name: 'Juniper', legacyKinId: 'office9' } },
        ],
      },
    });
    const res = await load(ctx);
    expect(res.tales[0]!.kinNames).toEqual(['Biscuit']);
  });
  it("a tale linked to another household's visit carries none of that visit's Kin, KinCare or day", async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'kin_care_sessions/s9': {
          kinfolkId: 'fam8',
          serviceType: 'Overnight Stay',
          startTime: '2026-11-02T15:00:00.000Z',
          kinIds: ['x1', 'x2'],
          kinNames: ['Rover', 'Fluff'],
        },
      },
      queryDocs: {
        kin_care_reports: [tale('r1', { sessionId: 's9' }), tale('r2', { sessionId: 's9', kinIds: ['x1'] })],
        'families/fam3/kin': FOUR_KIN,
      },
    });
    const res = await load(ctx);
    for (const t of res.tales) {
      expect(t.kinNames).toBeUndefined();
      expect(t.serviceLabel).toBeUndefined();
      expect(t.visitDate).toBeUndefined();
    }
    const wire = JSON.stringify(res);
    expect(wire).not.toContain('Rover');
    expect(wire).not.toContain('Fluff');
    expect(wire).not.toContain('Overnight');
  });
  it('a Kin read that fails leaves the names off and the tales still load', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: {
        kin_care_reports: [tale('r1', { kinIds: ['k1'], fieldResponses: fedForOneKinAndLightsOff() })],
      },
    });
    const realCollection = ctx.db.collection;
    ctx.db.collection = vi.fn((path: string) => {
      if (path === 'families/fam3/kin') throw new Error('kin read refused');
      return realCollection(path);
    }) as typeof ctx.db.collection;

    const res = await load(ctx);

    expect(res.tales).toHaveLength(1);
    expect(res.tales[0]!.kinNames).toBeUndefined();
    expect(res.tales[0]!.checklist).toEqual([
      { key: 'fed', text: 'Fed' },
      { key: 'lights_off', text: 'Lights turned off' },
    ]);
  });

  it('the default message a template supplied is the tale body, sent on as plain text', async () => {
    // #2050: the composer puts the template's default message in `bodyCopy`.
    // The feed returns it as stored; both portals print it as text, never markup.
    const body = 'Thanks for having us! <img src=x onerror=alert(1)>';
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: { kin_care_reports: [tale('r1', { bodyCopy: body })] },
    });

    const res = await load(ctx);

    expect(res.tales[0]!.body).toBe(body);
  });
});
