// Canonical audit event keys. Values are SCREAMING_SNAKE_CASE per the
// `activity_log` collection convention adopted across AuntieOS Android
// (data/admin/AuditLog.kt + ActivityLogEntry) and Web. Older dot-kebab
// values were retired 2026-05-19 when the Functions writer was repointed
// from `auditLog` to `activity_log`.
//
// Call sites reference these by KEY (e.g. AUDIT_EVENTS.AUTH_LOGIN_SUCCESS),
// so changing values does not require touching emit sites. Tests that
// assert literal event strings need updating to SCREAMING_SNAKE values.
export const AUDIT_EVENTS = {
  AUTH_SIGNUP_CLAIMED: 'AUTH_SIGNUP_CLAIMED',
  AUTH_LOGIN_SUCCESS: 'AUTH_LOGIN_SUCCESS',
  AUTH_LOGIN_FAIL: 'AUTH_LOGIN_FAIL',
  AUTH_LOGOUT_ALL: 'AUTH_LOGOUT_ALL',
  AUTH_RECOVERY_REQUESTED: 'AUTH_RECOVERY_REQUESTED',
  AUTH_RECOVERY_TRIGGERED: 'AUTH_RECOVERY_TRIGGERED',
  AUTH_CONTACT_SWAPPED: 'AUTH_CONTACT_SWAPPED',
  AUTH_BIOMETRIC_LOCKOUT: 'AUTH_BIOMETRIC_LOCKOUT',
  AUTH_PASSWORD_RESET_REQUESTED: 'AUTH_PASSWORD_RESET_REQUESTED',
  AUTH_PASSWORD_RESET_COMPLETED: 'AUTH_PASSWORD_RESET_COMPLETED',

  MEMBERSHIP_TRIBE_PROVISIONED: 'MEMBERSHIP_TRIBE_PROVISIONED',
  MEMBERSHIP_TRIBE_MIGRATED_V1: 'MEMBERSHIP_TRIBE_MIGRATED_V1',
  MEMBERSHIP_INVITE_SENT: 'MEMBERSHIP_INVITE_SENT',
  MEMBERSHIP_INVITE_ACCEPTED: 'MEMBERSHIP_INVITE_ACCEPTED',
  MEMBERSHIP_INVITE_REVOKED: 'MEMBERSHIP_INVITE_REVOKED',
  MEMBERSHIP_INVITE_EXPIRED: 'MEMBERSHIP_INVITE_EXPIRED',
  MEMBERSHIP_MEMBER_REMOVED: 'MEMBERSHIP_MEMBER_REMOVED',
  MEMBERSHIP_SECONDARY_LABEL_CHANGED: 'MEMBERSHIP_SECONDARY_LABEL_CHANGED',

  PERM_GRANTED: 'PERM_GRANTED',
  PERM_REVOKED: 'PERM_REVOKED',
  PERM_BILLING_GRANTED: 'PERM_BILLING_GRANTED',
  PERM_BILLING_REVOKED: 'PERM_BILLING_REVOKED',

  SECRETS_TRIBEPIN_SET: 'SECRETS_TRIBEPIN_SET',
  SECRETS_TRIBEPIN_CHANGE_REQUESTED: 'SECRETS_TRIBEPIN_CHANGE_REQUESTED',
  SECRETS_TRIBEPIN_VALIDATED: 'SECRETS_TRIBEPIN_VALIDATED',

  CONTENT_SHARE_LINK_CREATED: 'CONTENT_SHARE_LINK_CREATED',
  CONTENT_SHARE_LINK_REVOKED: 'CONTENT_SHARE_LINK_REVOKED',
  CONTENT_SHARE_LINK_EXPIRED: 'CONTENT_SHARE_LINK_EXPIRED',
  CONTENT_KINTALE_INGESTED: 'CONTENT_KINTALE_INGESTED',
  CONTENT_KINTALE_PHOTO_UPLOADED: 'CONTENT_KINTALE_PHOTO_UPLOADED',
  CONTENT_KINTALE_COMMENT_POSTED: 'CONTENT_KINTALE_COMMENT_POSTED',
  CONTENT_KINTALE_NOTE_ADDED: 'CONTENT_KINTALE_NOTE_ADDED',

  // Billing audit IS captured (creation/payment-status events), but per the
  // 2026-05-19 audit-scope decision we do NOT audit:
  //  - card / payment-method contents
  //  - billing reads (statement/invoice GET calls)
  // Only state transitions (created/paid/failed/method-changed) get logged
  // because they are needed to investigate disputed activity.
  BILLING_INVOICE_CREATED: 'BILLING_INVOICE_CREATED',
  // A quote is an invoice in QUOTE status (no separate model). The createQuote
  // callable mints it and the household answers it through acceptQuote /
  // denyQuote (portal/quoteDecision.ts), which are what finally emit the
  // quote.accepted and quote.denied catalog keys. This comment used to claim
  // the accept/deny flow already existed somewhere; it did not, and neither key
  // had an emitter anywhere in the repo until 2026-08-18 (issue #385).
  BILLING_QUOTE_CREATED: 'BILLING_QUOTE_CREATED',
  /** The household accepted a quote, so it is a bill from that moment on. */
  BILLING_QUOTE_ACCEPTED: 'BILLING_QUOTE_ACCEPTED',
  /** The household declined a quote. A different fact from the operator cancelling one. */
  BILLING_QUOTE_DENIED: 'BILLING_QUOTE_DENIED',
  /**
   * The office revised a declined quote and sent it back out
   * (admin/resendQuote.ts, issue #448). The resend CLEARS the decline off the
   * doc, so this entry is the only lasting record that the household ever said
   * no to it.
   */
  BILLING_QUOTE_RESENT: 'BILLING_QUOTE_RESENT',
  BILLING_INVOICE_PAID: 'BILLING_INVOICE_PAID',
  BILLING_INVOICE_FAILED: 'BILLING_INVOICE_FAILED',
  BILLING_RECEIPT_ISSUED: 'BILLING_RECEIPT_ISSUED',
  // Stage 3 / 16.2: a PDF render of an invoice was generated + stored (admin
  // download or kinfolk-portal download). The doc id only; no PII in payload.
  BILLING_INVOICE_PDF_GENERATED: 'BILLING_INVOICE_PDF_GENERATED',
  BILLING_PAYMENT_METHOD_CHANGED: 'BILLING_PAYMENT_METHOD_CHANGED',
  // Manual on-demand resend of an invoice reminder for ONE invoice
  // (sendInvoiceReminder callable). Mirrors the per-invoice dispatch the
  // invoiceRemindersCron does on its daily scan, but admin-initiated now.
  BILLING_REMINDER_SENT: 'BILLING_REMINDER_SENT',
  // Admin reviews and sends a DRAFT invoice to the household
  // (reviewAndSendDraftInvoice callable): DRAFT -> open, dispatches the
  // invoice.new notification. Distinct from BILLING_INVOICE_CREATED because
  // the invoice doc already existed as a draft; this is the review/publish
  // step, not the mint step.
  BILLING_DRAFT_INVOICE_SENT: 'BILLING_DRAFT_INVOICE_SENT',
  // Task 5.1: an invoice's fields and/or its line items were edited
  // (updateInvoice callable). Logged because it can CHANGE WHAT IS OWED after
  // the household has already seen a figure, which is exactly the kind of
  // state transition the note above says must be investigable.
  BILLING_INVOICE_UPDATED: 'BILLING_INVOICE_UPDATED',
  // Task 5.1: an invoice was archived or restored (archiveInvoice /
  // unarchiveInvoice). Archiving hides it from the operator's default view and
  // from the outstanding totals, so it is a deliberate decision to stop
  // chasing money, not a cosmetic filter.
  BILLING_INVOICE_ARCHIVED: 'BILLING_INVOICE_ARCHIVED',
  BILLING_INVOICE_UNARCHIVED: 'BILLING_INVOICE_UNARCHIVED',
  // W2-1 (ADR-0002): the invoice<->session link was manually curated through
  // linkInvoiceSessions (both directions in one transaction). Logged because
  // the link decides which visits an invoice bills for, so moving it after a
  // household has seen a figure is investigable state.
  BILLING_INVOICE_SESSIONS_LINKED: 'BILLING_INVOICE_SESSIONS_LINKED',
  // #408: completed work was taken out of the un-invoiced queue without being
  // billed, or put back into it (setSessionDoNotInvoice). Two keys rather than
  // one flag inside a payload, for the same reason the dispute keys are split:
  // "what have we decided never to bill for" has to be answerable by querying
  // `event`, and a decision not to charge a household for real work is exactly
  // what somebody asks about six months later.
  BILLING_SESSION_DO_NOT_INVOICE_SET: 'BILLING_SESSION_DO_NOT_INVOICE_SET',
  BILLING_SESSION_DO_NOT_INVOICE_CLEARED: 'BILLING_SESSION_DO_NOT_INVOICE_CLEARED',
  // W2-1 (ADR-0002): a row was created in the ROOT payments collection
  // (recordPayment callable): the display ledger the payment screens read,
  // distinct from BILLING_INVOICE_PAID which covers the invoice-settling
  // subcollection write in markInvoicePaid.
  BILLING_PAYMENT_RECORDED: 'BILLING_PAYMENT_RECORDED',
  // A cardholder's bank pulled a settled card payment back (`stripeWebhook`,
  // `charge.dispute.created` / `charge.dispute.closed`). Audited at `critical`
  // because it is the one place money leaves the account without anybody here
  // deciding it should, and because the invoice DELIBERATELY keeps reading
  // paid: this entry plus the invoice's `disputeStatus` flag ARE the record
  // that the money is contested. See `billing/stripeDispute.ts` for why
  // un-paying the invoice would be the dishonest answer, not the safe one.
  BILLING_PAYMENT_DISPUTED: 'BILLING_PAYMENT_DISPUTED',
  // The resolution (won / lost / warning_closed). Its own key rather than a
  // flag inside the payload for the same reason NOTIFICATIONS_UNARCHIVE is
  // separate: the trail is queried by `event`, so "which disputes have closed,
  // and how" must be answerable without reading every payload.
  BILLING_PAYMENT_DISPUTE_CLOSED: 'BILLING_PAYMENT_DISPUTE_CLOSED',
  // The money itself moving (`charge.dispute.funds_withdrawn` /
  // `charge.dispute.funds_reinstated`), which is a DIFFERENT fact from where the
  // contest stands: a dispute sits at `needs_response` for weeks with the
  // balance already debited. Separate keys for the same reason the close is
  // separate. "Which disputes have actually taken money out of the balance"
  // has to be answerable by querying `event`, not by reading every payload.
  // Withdrawal is `critical` (money gone, and nobody here decided it should be);
  // the reinstatement is the good half and is audited at `info`.
  BILLING_PAYMENT_DISPUTE_FUNDS_WITHDRAWN: 'BILLING_PAYMENT_DISPUTE_FUNDS_WITHDRAWN',
  BILLING_PAYMENT_DISPUTE_FUNDS_REINSTATED: 'BILLING_PAYMENT_DISPUTE_FUNDS_REINSTATED',
  // A SECOND Stripe payment landed on an invoice that had already taken one
  // (`stripeWebhook`, issue #826). Its own key rather than a payload flag on
  // BILLING_INVOICE_PAID, because the invoice was NOT paid again: the money
  // went to the household's account balance instead, and "which households paid
  // twice" has to be answerable by querying `event`.
  //
  // `critical`, on the same grounds as the dispute keys: money moved in a way
  // nobody here decided it should, and with no refunds ever (operator ruling,
  // 2026-08-06) an account-balance credit is the entire remedy. Somebody has to
  // know it happened.
  BILLING_PAYMENT_DUPLICATE_CREDITED: 'BILLING_PAYMENT_DUPLICATE_CREDITED',

  THEME_BRAND_TOKENS_UPDATED: 'THEME_BRAND_TOKENS_UPDATED',
  THEME_KINFOLK_OVERRIDES_UPDATED: 'THEME_KINFOLK_OVERRIDES_UPDATED',


  NOTIFICATION_DISPATCHED: 'NOTIFICATION_DISPATCHED',
  NOTIFICATION_RECEIVED: 'NOTIFICATION_RECEIVED',
  NOTIFICATION_VIEWED: 'NOTIFICATION_VIEWED',

  BOOKING_SUBMITTED: 'BOOKING_SUBMITTED',
  PROFILE_UPDATED: 'PROFILE_UPDATED',

  // #447: the Kin tagged in one `media_files` doc were changed (saveMediaTags).
  // Audited for the same reason PROFILE_UPDATED is: a tag says a named animal
  // was present at a visit, which is a claim about a household's record, and
  // until this callable landed the field was writable by any admin client with
  // nothing recorded at all. The payload carries the before and after lists, so
  // an accidental clear is recoverable from the trail rather than gone.
  MEDIA_TAGS_UPDATED: 'MEDIA_TAGS_UPDATED',

  // #397 S2: a `media_files` doc was destroyed (deleteMediaFile). The row is
  // gone once this fires, so the trail is the only surviving record that the
  // file existed and who removed it. The payload carries `storageUrl` because
  // the Cloudinary asset outlives the document (see deleteMediaFile.ts), and
  // that URL is the only route back to it afterwards.
  MEDIA_FILE_DELETED: 'MEDIA_FILE_DELETED',
  // ISSUE #519: the two retention purges, one entry per RUN rather than per
  // deleted document. A run that clears three thousand route points would
  // otherwise write three thousand chained audit entries and drown the trail it
  // exists to keep readable; the entry carries the count, the cutoff, and which
  // retention setting produced it, which is what an operator asking "what
  // happened to my routes" actually needs. A run that deletes nothing still
  // writes one, because "the job ran and found nothing" and "the job did not
  // run" are different answers.
  RETENTION_ROUTES_PURGED: 'RETENTION_ROUTES_PURGED',
  RETENTION_DRAFTS_PURGED: 'RETENTION_DRAFTS_PURGED',
  // A run that refused: the window was unreadable, zero, negative or absurd, so
  // nothing was deleted. Recorded at `warn` because a purge silently not running
  // is how an archive quietly grows forever.
  RETENTION_PURGE_SKIPPED: 'RETENTION_PURGE_SKIPPED',

  // formSchema admin authoring callables (saveFormSchema / deleteFormSchema).
  // Already SCREAMING_SNAKE per memory project_orphan_triage_shipped, kept
  // unchanged.
  SAVE_FORM_SCHEMA: 'SAVE_FORM_SCHEMA',
  DELETE_FORM_SCHEMA: 'DELETE_FORM_SCHEMA',

  // Orphan KinTale triage actions (M5 server-bound replacement for client-
  // emitted audits). Action types here match the SCREAMING_SNAKE strings
  // used in AuntieOS Android repo + Web __fb bridge prior to the refactor.
  TRIAGE_ORPHAN_REPORT_ASSIGN: 'TRIAGE_ORPHAN_REPORT_ASSIGN',
  TRIAGE_ORPHAN_REPORT_DUPLICATE: 'TRIAGE_ORPHAN_REPORT_DUPLICATE',
  TRIAGE_ORPHAN_REPORT_ARCHIVE: 'TRIAGE_ORPHAN_REPORT_ARCHIVE',

  ERROR_RULE_DENY: 'ERROR_RULE_DENY',
  ERROR_FUNCTION_FAILURE: 'ERROR_FUNCTION_FAILURE',

  // Admin feature-flag toggles (setFeatureFlags callable).
  ADMIN_FEATURE_FLAGS_UPDATED: 'ADMIN_FEATURE_FLAGS_UPDATED',
  // #713: one tag was deleted from a business_settings vocabulary AND stripped
  // off every kinfolk (or kin) doc carrying it. Audited because the strip is
  // not recoverable: the vocabulary row can be re-added, but which households
  // held the tag is gone the moment the batch commits. The payload carries the
  // record ids so the trail can answer that.
  BUSINESS_TAG_REMOVED: 'BUSINESS_TAG_REMOVED',

  // Care-ops session callables (1E §A.9): server-bound create + reschedule of
  // kin_care_sessions, replacing client-side patches so the audit is bound to
  // the mutation. Series-level approve/cancel (1G) on the parent booking doc.
  CREATE_KINCARE_SESSION: 'CREATE_KINCARE_SESSION',
  RESCHEDULE_BOOKING: 'RESCHEDULE_BOOKING',
  APPROVE_BOOKING_SERIES: 'APPROVE_BOOKING_SERIES',
  CANCEL_BOOKING_SERIES: 'CANCEL_BOOKING_SERIES',
  // Batch transition of N individual booking visits at once
  // (batchUpdateBookings callable): APPROVE -> confirmed, REJECT/CANCEL ->
  // cancelled (kinCares envelope ids, mirrored onto kin_care_sessions), or
  // APPROVE -> ACCEPTED, REJECT/CANCEL -> REJECTED (android's native
  // enhanced_bookings ids). Applied per-id and audited as one batch action.
  BOOKING_BATCH_ACTION: 'BOOKING_BATCH_ACTION',
  // #438: an operator ruled on a kinfolk's cancellation ask
  // (resolveBookingCancellationRequest). Separate from BOOKING_BATCH_ACTION,
  // which records the office cancelling of its own accord: this one records an
  // ANSWER to a household that asked, and a decline changes no status at all,
  // so it would otherwise leave no trace of a decision anyone made.
  CANCEL_REQUEST_RESOLVED: 'CANCEL_REQUEST_RESOLVED',
  // A3: ONE operator transition on ONE flat `kin_care_sessions` row
  // (transitionBookingStatus callable): APPROVE / REJECT / CANCEL / COMPLETE.
  // These four used to be a bare client `updateDoc` on the session document
  // with no audit at all; the callable is now their only path. The payload
  // records the action the operator CHOSE alongside the from/to statuses, which
  // is the only place the reject-vs-cancel distinction survives: the collection
  // stores both outcomes as `CANCELLED`.
  BOOKING_STATUS_TRANSITION: 'BOOKING_STATUS_TRANSITION',
  // The same callable REFUSING: a missing session, a status the state machine
  // cannot read, or a transition illegal from the row's current status. Logged
  // because "who tried to complete a cancelled visit" is exactly the question
  // an audit trail exists to answer, and a success-only trail cannot.
  BOOKING_TRANSITION_REFUSED: 'BOOKING_TRANSITION_REFUSED',
  // #397 L19: the IN-VISIT clock on one flat `kin_care_sessions` row
  // (setVisitLifecycle callable): On my way / Arrived / Departed / Undo
  // arrival. Kept apart from BOOKING_STATUS_TRANSITION above, which records the
  // four OPERATOR decisions, because the two answer different questions after
  // the fact: that one is "who approved, cancelled or completed this visit",
  // this one is "when did the Auntie actually arrive and leave, and who said
  // so". The payload carries whether the household was told, and why not when
  // it was not, since a clock-in that notified nobody is a different event from
  // one that did.
  VISIT_LIFECYCLE_SET: 'VISIT_LIFECYCLE_SET',
  // The same callable REFUSING: a missing session, an unreadable status, or an
  // action illegal from the row's current status (clocking out of a visit
  // nobody clocked into is the one this exists for). Same reasoning as
  // BOOKING_TRANSITION_REFUSED: a success-only trail cannot answer "who tried".
  VISIT_LIFECYCLE_REFUSED: 'VISIT_LIFECYCLE_REFUSED',
  // #397 L19: an operator edited the descriptive fields of one visit
  // (updateKinCareSession callable): serviceType, notes, duration, the Kin
  // roster. Records the field NAMES written, never their values.
  UPDATE_KINCARE_SESSION: 'UPDATE_KINCARE_SESSION',
  // #582: `verifyVisitArrival` measured a recorded arrival against the
  // household's stored coordinate. Written on EVERY outcome, including the ones
  // that verify nothing (no household coordinate, a fix too imprecise to be
  // evidence), because "the check did not run, and why" is the question an
  // operator asks when a visit completes unverified. The payload carries the
  // distance, the radius and the reported accuracy; it never carries the
  // coordinate the Auntie's device sent, which is measured and discarded.
  VISIT_ARRIVAL_LOCATION_CHECK: 'VISIT_ARRIVAL_LOCATION_CHECK',
  // B6: admin manually blocks a window so kinfolk can't book it (createBlockedTimeSlot).
  CREATE_BLOCKED_TIME_SLOT: 'CREATE_BLOCKED_TIME_SLOT',
  // #574: the same window unblocked again (deleteBlockedTimeSlot). Recorded
  // separately from the create rather than folded into it, because the delete
  // removes the only record the block ever had: once the document is gone,
  // "why was that afternoon closed, and who reopened it" has no other source.
  // Only an operator-authored INTERNAL_MANUAL slot can reach this event; a
  // Google Calendar mirror is refused before the delete.
  DELETE_BLOCKED_TIME_SLOT: 'DELETE_BLOCKED_TIME_SLOT',
  // Booking-write busy-conflict guard (`lib/bookingBusyConflict.ts`): an admin
  // explicitly booked over a Google Calendar busy import via
  // `overrideBusyConflict: true`. Never emitted for a kinfolk-initiated
  // request, which has no override. Logged because it is the one moment the
  // operator knowingly double-books their own calendar, which is exactly the
  // state a later "why is this visit here" question needs to find.
  BOOKING_BUSY_CONFLICT_OVERRIDDEN: 'BOOKING_BUSY_CONFLICT_OVERRIDDEN',
  // Visit-overlap guard (`lib/visitOverlapConflict.ts`, #397 M11/M12/M13): an
  // admin explicitly wrote over a visit that was already on the books, via
  // `overrideVisitConflict: true` — a second visit in the same window, a visit
  // dragged onto another, or a blocked-out window a promised visit occupies.
  // The sibling of BOOKING_BUSY_CONFLICT_OVERRIDDEN and separate from it,
  // because the two answer different questions after the fact: that one is
  // "the operator booked over their own calendar", this one is "the operator
  // double-booked an hour that was already promised".
  VISIT_OVERLAP_CONFLICT_OVERRIDDEN: 'VISIT_OVERLAP_CONFLICT_OVERRIDDEN',

  // O-8 AI copy gen: staff creates a tale-title backfill batch
  // (aiBackfillTaleTitles callable) and the poll cron applies the finished
  // results to kin_care_reports (aiBatchPollCron).
  AI_TALE_TITLES_BATCH_CREATED: 'AI_TALE_TITLES_BATCH_CREATED',
  AI_TALE_TITLES_APPLIED: 'AI_TALE_TITLES_APPLIED',

  // Bulk mark-as-read of the caller's own notifications
  // (bulkMarkNotificationsRead callable). Companion to the single
  // NOTIFICATION_VIEWED markNotificationRead emits.
  NOTIFICATIONS_BULK_READ: 'NOTIFICATIONS_BULK_READ',

  // Recipient (or admin) archives notification(s) out of the active inbox
  // (archiveNotification / bulkArchiveNotifications callables). Sets
  // `archivedAt`; recipient-scoped exactly like the mark-read guard.
  NOTIFICATIONS_ARCHIVE: 'NOTIFICATIONS_ARCHIVE',

  // The inverse (unarchiveNotification / bulkUnarchiveNotifications): a row put
  // back into the active inbox. Its own event rather than a flag inside
  // NOTIFICATIONS_ARCHIVE's payload, because the audit trail is queried by
  // `event`, and folding a restore into the archive event would make "what did
  // this operator file away last week" answerable only by reading payloads.
  NOTIFICATIONS_UNARCHIVE: 'NOTIFICATIONS_UNARCHIVE',

  // Tribal Intel generator (Phase 12 / spec 23): admin create/update/delete of
  // training_documents notes that the nightly reconcile pipeline folds into the
  // targeted client's Dossier and pet Kin411. The write is server-bound so the
  // audit entry is structurally tied to the mutation.
  CREATE_TRAINING_DOCUMENT: 'CREATE_TRAINING_DOCUMENT',
  UPDATE_TRAINING_DOCUMENT: 'UPDATE_TRAINING_DOCUMENT',
  DELETE_TRAINING_DOCUMENT: 'DELETE_TRAINING_DOCUMENT',

  // Integrations / scheduling (slice 8): admin-initiated server-side import of
  // a shared Google Calendar's Busy intervals into private `booking_time_slots`
  // BLOCKED slots. The read + Firestore write happen server-side via ADC so no
  // service-account key ships in any client bundle.
  INTEGRATION_CALENDAR_SYNC: 'INTEGRATION_CALENDAR_SYNC',

  // Task 7.2, the OAuth half: connecting a Google account AuntieOS may WRITE
  // to, dropping that connection, and pushing visits onto the chosen calendar.
  // Kept separate from INTEGRATION_CALENDAR_SYNC above because the blast radius
  // differs: that one imports availability through a service account, these act
  // on a real person's calendar under their own consent. The payloads carry the
  // account address and counts and NEVER the refresh token, because an audit
  // entry is readable by any Auntie, which is exactly who must not be handed a
  // standing credential.
  INTEGRATION_CALENDAR_CONNECTED: 'INTEGRATION_CALENDAR_CONNECTED',
  INTEGRATION_CALENDAR_DISCONNECTED: 'INTEGRATION_CALENDAR_DISCONNECTED',
  INTEGRATION_CALENDAR_PUSH: 'INTEGRATION_CALENDAR_PUSH',

  // Stage 2 step 5 (Communicate external send): admin sends a one-off email or
  // SMS to an arbitrary recipient. The recipient is REDACTED in the audit
  // payload (masked local-part / middle digits) so the activity_log never
  // stores a plaintext contact for a one-off blast. EXTERNAL_SUPPRESSION_ADDED
  // records an opt-out written to `message_suppressions` so future sends are
  // blocked at the source.
  EXTERNAL_MESSAGE_SENT: 'EXTERNAL_MESSAGE_SENT',
  EXTERNAL_SUPPRESSION_ADDED: 'EXTERNAL_SUPPRESSION_ADDED',

  // Stage 2 step 6 (Communicate broadcast): admin saves a reusable audience
  // segment (a saved kinfolk filter) and sends a multichannel broadcast
  // (in-app / email / sms / push) to everyone the segment resolves to. The
  // broadcast audit payload carries per-channel sent/skipped/failed counts and
  // never a plaintext recipient (the fan-out honors message_suppressions and
  // records only aggregate counts in `broadcasts`).
  AUDIENCE_SEGMENT_SAVED: 'AUDIENCE_SEGMENT_SAVED',
  AUDIENCE_SEGMENT_DELETED: 'AUDIENCE_SEGMENT_DELETED',
  BROADCAST_SENT: 'BROADCAST_SENT',

  // Marketing blasts: a SCHEDULED campaign, as against the broadcast above,
  // which sends now. The payload carries the blast id, the catalog key, the
  // fire time and the dispatched/suppressed counts, and never a recipient: the
  // audience is described by its criteria, exactly as a broadcast's is.
  // CANCELLED records a queued campaign called back before it fired, with the
  // number of scheduled copies deleted.
  MARKETING_BLAST_SCHEDULED: 'MARKETING_BLAST_SCHEDULED',
  MARKETING_BLAST_CANCELLED: 'MARKETING_BLAST_CANCELLED',

  // Stage 2 step 7 (Inbox conversations / Message Auntie 16.4): two-way threads
  // between a kinfolk household and the auntie. SENT = kinfolk -> auntie (portal),
  // REPLIED = auntie -> kinfolk (admin). Body is not stored in the audit payload,
  // only the kinfolkId + message id.
  CONVERSATION_MESSAGE_SENT: 'CONVERSATION_MESSAGE_SENT',
  CONVERSATION_REPLIED: 'CONVERSATION_REPLIED',
  // markAllThreadsRead: ONE row for the whole bulk clear, carrying the count and
  // the thread ids it touched. A state change over other people's messages
  // should be attributable, the same reason the notifications bulk read is.
  CONVERSATIONS_BULK_READ: 'CONVERSATIONS_BULK_READ',

  // RULING O-6 (docs/RULING_O-6_OPERATOR_TRUST_2026-07-13.md) hardening 2:
  // staff cross-tenant power is total (any kinfolkId, any household), so the
  // audit trail is the compensating control. Emitted by resolveKinfolkAccess
  // whenever a staff caller resolves a kinfolkId NOT in their own
  // clients/{uid}.kinfolkIds — i.e. every genuine cross-household access,
  // not every staff call (a staff member acting on their own linked
  // household, if any, is not "cross-tenant").
  OPERATOR_CROSSTENANT_ACCESS: 'OPERATOR_CROSSTENANT_ACCESS',

  // Dashboard-widget ops (AO-39/40/41): admin-only quick-log + tracker writes.
  // All go through server-bound callables so the audit entry is structurally
  // tied to the mutation. Reads (listExpenses/listSupplies/listExpirations/
  // optimizeRoute) are NOT audited, matching the read-callable convention.
  EXPENSE_LOGGED: 'EXPENSE_LOGGED',
  SUPPLY_ADJUSTED: 'SUPPLY_ADJUSTED',
  SUPPLY_UPSERTED: 'SUPPLY_UPSERTED',
  EXPIRATION_UPSERTED: 'EXPIRATION_UPSERTED',
  // A brand logo was set or cleared on `business_settings`
  // (confirmBrandAssetUpload). Payload carries the kind (businessLogo /
  // portalLogo) and the action, never the URL: the asset is operator-supplied
  // branding, and the doc itself is the record of what it currently is.
  BRANDING_ASSET_UPDATED: 'BRANDING_ASSET_UPDATED',

  // Shared `vet_clinics` catalog writes (punchlist B4). Until these landed, the
  // only mutation on this collection was `submitVetClinic` (create, unaudited)
  // plus two DIRECT client writes from the Kotlin trees, so a clinic's phone
  // number could be changed, or the row hard-deleted, with nothing recorded.
  //
  // This collection is audited where the create path is not, because an update
  // FANS OUT: correcting a clinic rewrites the denormalized name/phone/address
  // on every `kinfolk` doc linked to it. One call can therefore change the
  // number a sitter dials in an emergency across many households, so the
  // payload carries that household count and the trail says how far it reached.
  VET_CLINIC_UPDATED: 'VET_CLINIC_UPDATED',
  // Archive and unarchive share one event, separated by `payload.archived`,
  // matching the set-and-clear-on-one-doc convention in CALLABLE_CONTRACT.md.
  VET_CLINIC_ARCHIVED: 'VET_CLINIC_ARCHIVED',
  // Refusals: a duplicate rename, a missing clinic, a redundant archive flip.
  // A success-only trail cannot answer "who tried to rename a clinic onto
  // another one", which is the shape an accidental catalog merge takes.
  VET_CLINIC_WRITE_REFUSED: 'VET_CLINIC_WRITE_REFUSED',
} as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];
