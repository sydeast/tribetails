// GENERATED FILE. DO NOT EDIT.
//
// The Contracts module (CONTEXT.md), generated from the server zod schemas
// under ADR-0001 decision 2. The schema is the authority for both directions;
// this file is a projection of it and any hand edit is lost on the next run.
//
// Source:      mytribe/functions/src/{admin,portal}/*.ts (zod Args + Result)
// Regenerate:  npm --prefix mytribe/functions run contracts:generate
// Verify:      npm --prefix mytribe/functions run contracts:check
//
// CI runs the verify command and fails on any difference, so a schema change
// and its generated fallout land in one reviewable commit.

// ---------- Types shared by more than one callable ----------

/**
 * `RescheduleRequestDto`, shared across callables.
 */
export interface RescheduleRequestDto {
  kinfolkId: string;
  batchId: string;
  visitId: string;
  title: string | null;
  serviceType: string | null;
  kinNames: string[];
  status: string | null;
  currentStartTimeMs: number | null;
  currentEndTimeMs: number | null;
  proposedStartTimeMs: number | null;
  proposedEndTimeMs: number | null;
  reason: string | null;
  requestedAtMs: number | null;
}

/**
 * `CancelRequestDto`, shared across callables.
 */
export interface CancelRequestDto {
  kinfolkId: string;
  batchId: string;
  visitId: string;
  title: string | null;
  serviceType: string | null;
  kinNames: string[];
  status: string | null;
  startTimeMs: number | null;
  endTimeMs: number | null;
  reason: string | null;
  requestedAtMs: number | null;
}

// ---------- addBookingNote ----------

/**
 * Request payload for the `addBookingNote` callable.
 * The server also enforces a cross-field rule this type cannot express (zod .refine);
 * a payload that satisfies the type can still be refused.
 */
export interface AddBookingNoteArgs {
  kinfolkId?: string;
  batchId?: string;
  visitId?: string;
  bookingId?: string;
  body: string;
}

/**
 * Response from the `addBookingNote` callable.
 */
export interface AddBookingNoteResult {
  noteId: string;
}

// ---------- addInternalBookingNote ----------

/**
 * Request payload for the `addInternalBookingNote` callable.
 * The server also enforces a cross-field rule this type cannot express (zod .refine);
 * a payload that satisfies the type can still be refused.
 */
export interface AddInternalBookingNoteArgs {
  kinfolkId: string;
  batchId?: string;
  visitId?: string;
  bookingId?: string;
  body: string;
}

/**
 * Response from the `addInternalBookingNote` callable.
 */
export interface AddInternalBookingNoteResult {
  noteId: string;
}

// ---------- batchUpdateBookings ----------

/**
 * Request payload for the `batchUpdateBookings` callable.
 */
export interface BatchUpdateBookingsArgs {
  ids: string[];
  action: 'APPROVE' | 'REJECT' | 'CANCEL';
}

/**
 * Nested in the `batchUpdateBookings` contract.
 */
export interface BatchUpdateBookingsResultFailed {
  id: string;
  error: string;
}

/**
 * Response from the `batchUpdateBookings` callable.
 */
export interface BatchUpdateBookingsResult {
  ok: true;
  action: 'APPROVE' | 'REJECT' | 'CANCEL';
  updated: number;
  failed: BatchUpdateBookingsResultFailed[];
}

// ---------- createMultiDateBookingRequest ----------

/**
 * Nested in the `createMultiDateBookingRequest` contract.
 */
export interface CreateMultiDateBookingRequestArgsVisit {
  startTimeMs: number;
  endTimeMs: number | null;
  serviceId: string | null;
  serviceName: string;
  priceCents: number | null;
}

/**
 * Nested in the `createMultiDateBookingRequest` contract.
 */
export interface CreateMultiDateBookingRequestArgsBilling {
  mode: 'new-invoice';
}

/**
 * Nested in the `createMultiDateBookingRequest` contract.
 */
export interface CreateMultiDateBookingRequestArgsCommunication {
  emailConfirmation: boolean;
  timeVisibility: boolean;
}

/**
 * Request payload for the `createMultiDateBookingRequest` callable.
 */
export interface CreateMultiDateBookingRequestArgs {
  kinfolkId: string;
  kinIds?: string[];
  notes?: string;
  pattern?: 'individual' | 'weekly';
  weeklyDays?: number[];
  visits: CreateMultiDateBookingRequestArgsVisit[];
  billing?: CreateMultiDateBookingRequestArgsBilling;
  communication?: CreateMultiDateBookingRequestArgsCommunication;
  overrideBusyConflict?: boolean;
}

/**
 * Response from the `createMultiDateBookingRequest` callable.
 */
export interface CreateMultiDateBookingRequestResult {
  batchId: string;
  visitIds: string[];
  visitCount: number;
}

// ---------- getMyBookings ----------

// No request type: `getMyBookings` has no zod request schema on the server,
// so there is no authority to generate one from.

/**
 * Nested in the `getMyBookings` contract.
 */
export interface GetMyBookingsResultLiveVisit {
  id: string;
  batchId: string | null;
  kinfolkId: string;
  status: 'requested' | 'confirmed' | 'enRoute' | 'active' | 'completed' | 'cancelled';
  serviceType: string | null;
  title: string | null;
  startTimeMs: number | null;
  endTimeMs: number | null;
  kinIds: string[];
  kinNames: string[];
  auntieDisplayName: string | null;
  auntieAvatarUrl: string | null;
  notes: string | null;
  requestedByUid: string | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  visitProgress: 'confirmed' | 'enRoute' | 'active' | 'ended' | null;
  sourceBookingId: string | null;
  sessionId: string | null;
  cancelRequested: boolean;
  cancelRequestStatus: 'pending' | 'accepted' | 'declined' | null;
  cancelRequestReason: string | null;
  cancelResponseNote: string | null;
  rescheduleRequestStatus: 'pending' | 'accepted' | 'declined' | null;
  rescheduleRequestedStartTimeMs: number | null;
  rescheduleRequestedEndTimeMs: number | null;
  rescheduleRequestReason: string | null;
  rescheduleResponseNote: string | null;
}

/**
 * Nested in the `getMyBookings` contract.
 */
export interface GetMyBookingsResultEnvelope {
  batchId: string;
  envelopeStatus: 'requested' | 'partiallyConfirmed' | 'confirmed' | 'inProgress' | 'completed' | 'cancelled';
  pattern: 'individual' | 'weekly';
  serviceName: string | null;
  kinIds: string[];
  kinNames: string[];
  notes: string | null;
  visitCount: number;
  confirmedCount: number;
  completedCount: number;
  firstStartTimeMs: number | null;
  lastStartTimeMs: number | null;
  kinCares: GetMyBookingsResultLiveVisit[];
}

/**
 * Response from the `getMyBookings` callable.
 */
export interface GetMyBookingsResult {
  liveVisit: GetMyBookingsResultLiveVisit | null;
  upcoming: GetMyBookingsResultLiveVisit[];
  recent: GetMyBookingsResultLiveVisit[];
  envelopes: GetMyBookingsResultEnvelope[];
}

// ---------- manageBookingSeries ----------

/**
 * Request payload for the `manageBookingSeries` callable.
 */
export interface ManageBookingSeriesArgs {
  action: 'APPROVE' | 'CANCEL';
  kinfolkId: string;
  batchId: string;
}

/**
 * Response from the `manageBookingSeries` callable.
 */
export interface ManageBookingSeriesResult {
  ok: true;
  action: 'APPROVE' | 'CANCEL';
  batchId: string;
  affectedVisits: number;
  sessionsCreated: number;
  failedVisits: number;
}

// ---------- requestBooking ----------

/**
 * Nested in the `requestBooking` contract.
 */
export interface RequestBookingArgsVisit {
  startTimeMs: number;
  endTimeMs: number | null;
  serviceId: string;
  serviceName: string;
  priceCents: number | null;
}

/**
 * Nested in the `requestBooking` contract.
 */
export interface RequestBookingArgsBilling {
  mode: 'new-invoice';
}

/**
 * Nested in the `requestBooking` contract.
 */
export interface RequestBookingArgsCommunication {
  emailConfirmation: boolean;
  timeVisibility: boolean;
}

/**
 * Request payload for the `requestBooking` callable.
 */
export interface RequestBookingArgs {
  kinfolkId?: string;
  kinIds?: string[];
  notes?: string;
  pattern?: 'individual' | 'weekly';
  weeklyDays?: number[];
  visits?: RequestBookingArgsVisit[];
  billing?: RequestBookingArgsBilling;
  communication?: RequestBookingArgsCommunication;
  serviceType?: string;
  title?: string;
  startTimeMs?: number;
  endTimeMs?: number;
}

/**
 * Response from the `requestBooking` callable.
 */
export interface RequestBookingResult {
  batchId: string;
  bookingIds: string[];
  bookingId: string;
}

// ---------- requestBookingCancellation ----------

/**
 * Request payload for the `requestBookingCancellation` callable.
 */
export interface RequestBookingCancellationArgs {
  kinfolkId?: string;
  batchId: string;
  visitId: string;
  reason?: string;
}

/**
 * Response from the `requestBookingCancellation` callable.
 */
export interface RequestBookingCancellationResult {
  ok: true;
  visitId: string;
  alreadyPending: boolean;
}

// ---------- requestBookingReschedule ----------

/**
 * Request payload for the `requestBookingReschedule` callable.
 */
export interface RequestBookingRescheduleArgs {
  kinfolkId?: string;
  batchId: string;
  visitId: string;
  proposedStartTimeMs: number;
  proposedEndTimeMs?: number;
  reason?: string;
}

/**
 * Response from the `requestBookingReschedule` callable.
 */
export interface RequestBookingRescheduleResult {
  ok: true;
  visitId: string;
  proposedStartTimeMs: number;
  proposedEndTimeMs: number | null;
}

// ---------- rescheduleBooking ----------

/**
 * Request payload for the `rescheduleBooking` callable.
 */
export interface RescheduleBookingArgs {
  sessionId: string;
  startTime: string;
  endTime: string;
}

/**
 * Response from the `rescheduleBooking` callable.
 */
export interface RescheduleBookingResult {
  ok: true;
  sessionId: string;
}

// ---------- resolveBookingRescheduleRequest ----------

/**
 * Request payload for the `resolveBookingRescheduleRequest` callable.
 */
export interface ResolveBookingRescheduleRequestArgs {
  kinfolkId: string;
  batchId: string;
  visitId: string;
  decision: 'accept' | 'decline';
  note?: string;
}

/**
 * Response from the `resolveBookingRescheduleRequest` callable.
 */
export interface ResolveBookingRescheduleRequestResult {
  ok: true;
  visitId: string;
  decision: 'accept' | 'decline';
  startTimeMs: number | null;
  sessionUpdated: boolean;
}

// ---------- listRescheduleRequests ----------

/**
 * Request payload for the `listRescheduleRequests` callable.
 */
export interface ListRescheduleRequestsArgs {
  limit?: number;
}

/**
 * Response from the `listRescheduleRequests` callable.
 */
export interface ListRescheduleRequestsResult {
  requests: RescheduleRequestDto[];
}

// ---------- resolveBookingCancellationRequest ----------

/**
 * Request payload for the `resolveBookingCancellationRequest` callable.
 */
export interface ResolveBookingCancellationRequestArgs {
  kinfolkId: string;
  batchId: string;
  visitId: string;
  decision: 'accept' | 'decline';
  note?: string;
}

/**
 * Response from the `resolveBookingCancellationRequest` callable.
 */
export interface ResolveBookingCancellationRequestResult {
  ok: true;
  visitId: string;
  decision: 'accept' | 'decline';
  status: string | null;
  sessionUpdated: boolean;
  rescheduleRequestClosed: boolean;
}

// ---------- listCancelRequests ----------

/**
 * Request payload for the `listCancelRequests` callable.
 */
export interface ListCancelRequestsArgs {
  limit?: number;
}

/**
 * Response from the `listCancelRequests` callable.
 */
export interface ListCancelRequestsResult {
  requests: CancelRequestDto[];
}
