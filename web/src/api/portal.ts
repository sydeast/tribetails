import { call } from '../lib/fns';
import { FUNCTIONS_HTTP_BASE } from '../lib/firebase';
import type {
  AcceptInviteRequest,
  AcceptInviteResult,
  ArchiveKinRequest,
  ArchiveKinResult,
  BusinessContactDto,
  ClaimInviteSignupRequest,
  ClaimInviteSignupResult,
  ConfirmSecureResetRequest,
  ConfirmSecureResetResult,
  GetInvitePreviewRequest,
  GetMyAccessResult,
  GetMyBookingsRequest,
  GetMyBookingsResult,
  GetMyHomeRequest,
  GetMyHomeResult,
  GetMyKinRequest,
  GetMyKinResult,
  GetMyKinTalesRequest,
  GetMyKinTalesResult,
  GetMyVisitsRequest,
  GetMyVisitsResult,
  InvitePreviewResult,
  KinPayloadPartial,
  UpdateKinRequest,
  UpdateKinResult,
} from './types';

/** Access list for the signed-in user; drives launch routing (NoTribes / Home / Pick). */
export function getMyAccess(): Promise<GetMyAccessResult> {
  return call<Record<string, never>, GetMyAccessResult>('getMyAccess', {});
}

/**
 * O-5: re-mints the `kinfolkId` custom claim after a TribePicker selection,
 * so direct-Firestore-rules-gated reads (live GPS breadcrumbs) honor the
 * pick — before this, only callable reads (which pass kinfolkId explicitly)
 * did. See `activeTribe.ts`'s `setActiveKinfolkId`, which calls this.
 */
export function setActiveTribe(kinfolkId: string): Promise<{ ok: true; kinfolkId: string }> {
  return call<{ kinfolkId: string }, { ok: true; kinfolkId: string }>('setActiveTribe', { kinfolkId });
}

export interface TribeSummary {
  id: string;
  displayName: string;
}

/**
 * Ported from PortalApi.kt's getTribeSummaries: there's no dedicated
 * "list my tribes" callable, so the picker fans out one getMyHome(id) per
 * candidate tribe and takes displayName. A per-id failure degrades to a
 * generic label rather than failing the whole picker.
 */
export async function getTribeSummaries(kinfolkIds: string[]): Promise<TribeSummary[]> {
  return Promise.all(
    kinfolkIds.map(async (id) => {
      try {
        const home = await getMyHome(id);
        return { id, displayName: home.displayName || `Tribe ${id}` };
      } catch {
        return { id, displayName: `Tribe ${id}` };
      }
    }),
  );
}

/** Home payload (identity + portal config) for one kinfolk tribe. */
export function getMyHome(kinfolkId?: string): Promise<GetMyHomeResult> {
  const payload: GetMyHomeRequest = kinfolkId !== undefined ? { kinfolkId } : {};
  return call<GetMyHomeRequest, GetMyHomeResult>('getMyHome', payload);
}

/** Live visit + upcoming/recent bookings (envelope-grouped). */
export function getMyBookings(kinfolkId?: string): Promise<GetMyBookingsResult> {
  const payload: GetMyBookingsRequest = kinfolkId !== undefined ? { kinfolkId } : {};
  return call<GetMyBookingsRequest, GetMyBookingsResult>('getMyBookings', payload);
}

/** AuntieOS-owned visit history (kin_care_sessions), incl. GPS route/summary. */
export function getMyVisits(kinfolkId?: string, limit?: number): Promise<GetMyVisitsResult> {
  const payload: GetMyVisitsRequest = {
    ...(kinfolkId !== undefined ? { kinfolkId } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
  return call<GetMyVisitsRequest, GetMyVisitsResult>('getMyVisits', payload);
}

/** The kinfolk's kin roster, including memorialized (noLongerWithUs) entries. */
export function getMyKin(kinfolkId?: string): Promise<GetMyKinResult> {
  const payload: GetMyKinRequest = kinfolkId !== undefined ? { kinfolkId } : {};
  return call<GetMyKinRequest, GetMyKinResult>('getMyKin', payload);
}

/** Toggles a kin between active and memorialized (noLongerWithUs). */
export function archiveKin(kinId: string, reason: 'noLongerWithUs' | 'restore', kinfolkId?: string): Promise<ArchiveKinResult> {
  const payload: ArchiveKinRequest = { kinId, reason, ...(kinfolkId !== undefined ? { kinfolkId } : {}) };
  return call<ArchiveKinRequest, ArchiveKinResult>('archiveKin', payload);
}

/**
 * Merges an editable subset of one kin's fields. The `kin_edit` permission is
 * enforced server-side; a denial throws and must surface (fail loud).
 */
export function updateKin(kinId: string, kin: KinPayloadPartial, kinfolkId?: string): Promise<UpdateKinResult> {
  const payload: UpdateKinRequest = { kinId, kin, ...(kinfolkId !== undefined ? { kinfolkId } : {}) };
  return call<UpdateKinRequest, UpdateKinResult>('updateKin', payload);
}

/** Most-recent-first KinTales (kin_care_reports), paginated. */
export function getMyKinTales(kinfolkId?: string, opts?: { before?: number; limit?: number }): Promise<GetMyKinTalesResult> {
  const payload: GetMyKinTalesRequest = {
    ...(kinfolkId !== undefined ? { kinfolkId } : {}),
    ...(opts?.before !== undefined ? { before: opts.before } : {}),
    ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
  };
  return call<GetMyKinTalesRequest, GetMyKinTalesResult>('getMyKinTales', payload);
}

/** Public-facing business contact details (name/email/phone/address). */
export function getBusinessContact(): Promise<BusinessContactDto> {
  return call<Record<string, never>, BusinessContactDto>('getBusinessContact', {});
}

/** Public invite preview for the claim screen (no auth required). */
export function getInvitePreview(inviteId: string): Promise<InvitePreviewResult> {
  return call<GetInvitePreviewRequest, InvitePreviewResult>('getInvitePreview', { inviteId });
}

/**
 * Public server-side account creation for invited kinfolk. Client signup is
 * project-disabled; this returns a custom token to sign in with, after which
 * the client calls acceptInvite. Existing account throws already-exists.
 */
export function claimInviteSignup(inviteId: string, password: string): Promise<ClaimInviteSignupResult> {
  return call<ClaimInviteSignupRequest, ClaimInviteSignupResult>('claimInviteSignup', {
    inviteId,
    password,
  });
}

/** Authed. Caller's token email must match the invite. Idempotent per claiming uid. */
export function acceptInvite(inviteId: string): Promise<AcceptInviteResult> {
  return call<AcceptInviteRequest, AcceptInviteResult>('acceptInvite', { inviteId });
}

/**
 * Public onRequest endpoint (not a callable): consumes the oobCode, sets the
 * new password, records a security incident, and alerts the business.
 * Called signed-out from the secure-reset screen. Fail-loud.
 */
export async function confirmSecureReset(req: ConfirmSecureResetRequest): Promise<ConfirmSecureResetResult> {
  const res = await fetch(`${FUNCTIONS_HTTP_BASE}/confirmSecureReset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body['ok'] !== true) {
    if (res.status === 429) {
      throw new Error('Too many attempts for this email today. Try again tomorrow or contact Tribe Tails.');
    }
    throw new Error('Could not secure your account. The reset link may have expired.');
  }
  return body as unknown as ConfirmSecureResetResult;
}
