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
  // A quote is an invoice in QUOTE status (no separate model). createQuote
  // callable mints it; accept/deny flow reuses quote.accepted/quote.denied.
  BILLING_QUOTE_CREATED: 'BILLING_QUOTE_CREATED',
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

  THEME_BRAND_TOKENS_UPDATED: 'THEME_BRAND_TOKENS_UPDATED',
  THEME_KINFOLK_OVERRIDES_UPDATED: 'THEME_KINFOLK_OVERRIDES_UPDATED',

  NOTIFICATION_DISPATCHED: 'NOTIFICATION_DISPATCHED',
  NOTIFICATION_RECEIVED: 'NOTIFICATION_RECEIVED',
  NOTIFICATION_VIEWED: 'NOTIFICATION_VIEWED',

  BOOKING_SUBMITTED: 'BOOKING_SUBMITTED',
  PROFILE_UPDATED: 'PROFILE_UPDATED',

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

  // Care-ops session callables (1E §A.9): server-bound create + reschedule of
  // kin_care_sessions, replacing client-side patches so the audit is bound to
  // the mutation. Series-level approve/cancel (1G) on the parent booking doc.
  CREATE_KINCARE_SESSION: 'CREATE_KINCARE_SESSION',
  RESCHEDULE_BOOKING: 'RESCHEDULE_BOOKING',
  APPROVE_BOOKING_SERIES: 'APPROVE_BOOKING_SERIES',
  CANCEL_BOOKING_SERIES: 'CANCEL_BOOKING_SERIES',
  // Batch transition of N individual booking visits at once
  // (batchUpdateBookings callable): APPROVE -> confirmed, REJECT/CANCEL ->
  // cancelled, applied per-id and audited as one batch action.
  BOOKING_BATCH_ACTION: 'BOOKING_BATCH_ACTION',
  // B6: admin manually blocks a window so kinfolk can't book it (createBlockedTimeSlot).
  CREATE_BLOCKED_TIME_SLOT: 'CREATE_BLOCKED_TIME_SLOT',

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

  // Stage 2 step 7 (Inbox conversations / Message Auntie 16.4): two-way threads
  // between a kinfolk household and the auntie. SENT = kinfolk -> auntie (portal),
  // REPLIED = auntie -> kinfolk (admin). Body is not stored in the audit payload,
  // only the kinfolkId + message id.
  CONVERSATION_MESSAGE_SENT: 'CONVERSATION_MESSAGE_SENT',
  CONVERSATION_REPLIED: 'CONVERSATION_REPLIED',

  // RULING O-6 (docs/RULING_O-6_OPERATOR_TRUST_2026-07-13.md) hardening 2:
  // staff cross-tenant power is total (any kinfolkId, any household), so the
  // audit trail is the compensating control. Emitted by resolveKinfolkAccess
  // whenever a staff caller resolves a kinfolkId NOT in their own
  // clients/{uid}.kinfolkIds — i.e. every genuine cross-household access,
  // not every staff call (a staff member acting on their own linked
  // household, if any, is not "cross-tenant").
  OPERATOR_CROSSTENANT_ACCESS: 'OPERATOR_CROSSTENANT_ACCESS',
} as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];
