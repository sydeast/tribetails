import { describe, it, expect } from 'vitest';
import { kinRemovalOption } from './kinRemoval';
import type { DeleteKinResult, KinRemovalRequestDto } from '../api/types';

const request = (overrides: Partial<KinRemovalRequestDto> = {}): KinRemovalRequestDto => ({
  id: 'fam1_k1',
  kinfolkId: 'fam1',
  kinId: 'k1',
  flatKinId: 'flat1',
  kinName: 'Max',
  reason: 'Added by mistake',
  status: 'pending',
  requestedAtMs: Date.UTC(2026, 10, 11, 12),
  resolvedAtMs: null,
  resolutionNote: null,
  ...overrides,
});

const result = (overrides: Partial<DeleteKinResult>): DeleteKinResult => ({
  ok: true,
  deleted: false,
  canDelete: false,
  blockedBy: [],
  removalRequest: null,
  ...overrides,
});

describe('kinRemovalOption', () => {
  it('nothing on file: delete', () => {
    expect(kinRemovalOption(result({ canDelete: true }))).toEqual({ kind: 'delete' });
  });

  // #1912: a Kin that shared its name with an archived Kin was told it had
  // history, and a removal request was sent for it. The server now answers
  // that it has nothing on file while that request is still waiting. Delete
  // is what the household gets; the request leaves with the Kin.
  it('nothing on file with a request still waiting: delete, not "Removal requested"', () => {
    expect(kinRemovalOption(result({ canDelete: true, removalRequest: request() }))).toEqual({ kind: 'delete' });
  });

  it('history on file and no request: ask the office', () => {
    expect(kinRemovalOption(result({ blockedBy: ['visits'] }))).toEqual({ kind: 'request', declined: null });
  });

  it('history on file and a request waiting: pending', () => {
    const waiting = request();
    expect(kinRemovalOption(result({ blockedBy: ['visits'], removalRequest: waiting }))).toEqual({ kind: 'pending', request: waiting });
  });

  it('a declined request comes back as ask again, with the answer', () => {
    const declined = request({ status: 'declined', resolutionNote: 'A visit is booked.' });
    expect(kinRemovalOption(result({ blockedBy: ['visits'], removalRequest: declined }))).toEqual({ kind: 'request', declined });
  });
});
