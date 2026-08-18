import type { NotificationDef, RecipientResolver } from './types';

/**
 * WHO a notification reaches, WHAT fires it, and WHAT the emitter puts in the
 * merge bag — the three facts that existed only in source code until #396.
 *
 * The operator's complaint was not that these facts were wrong. It was that
 * they were unreadable: "I am blind to what could be sent out to users. Meaning
 * we could be leaking info to the wrong ppl, but I have no idea because I dont
 * know the triggers and messages." Every answer below was already true of the
 * running system; none of it was on a screen.
 *
 * WHY THIS FILE AND NOT A FIELD ON THE CATALOG. Two of the three facts are not
 * the catalog's to hold. `recipientResolver` already lives there and is merely
 * projected (see `whoReceives`). But nothing in `catalog.ts` knows which
 * emitter calls `enqueueNotification` for a key, and nothing knows what that
 * call site puts in `data` — those are properties of the CALLER, and a catalog
 * row cannot be the source of truth for code it has never heard of. Recording
 * them here keeps the catalog a description of the message and this file a
 * description of the wiring.
 *
 * WHAT KEEPS IT HONEST. `test/notificationProvenance.test.ts`, modelled on the
 * TEMPLATE_FIELDS / seeds drift guard, checks all four directions:
 *   1. every catalog key is either emitted or explicitly listed in NEVER_FIRES,
 *      and never both;
 *   2. every `source` names a file that exists and contains that key literally;
 *   3. the set of files calling `enqueueNotification` is exactly the set of
 *      files named here, so a new emitter cannot land undocumented;
 *   4. the same, for `sendFromTemplate` and UNGATED_SENDS.
 * Rule 3 is the one that matters: it fails the build for the next person who
 * adds an emitter and forgets this file, which is the only way a hand-authored
 * map stays true.
 *
 * Paths are relative to `mytribe/functions/`, which is what the drift guard
 * resolves and what an operator reading the screen can hand to an engineer.
 */

/** One call site that dispatches a catalog key. */
export interface EmitterDescriptor {
  /**
   * What actually happens in the business, in the operator's words. Not the
   * function name: "A household asks to cancel a visit", not "onBookingsWrite".
   */
  trigger: string;
  /** Where it lives, so the answer is checkable. Relative to mytribe/functions/. */
  source: string;
  /**
   * The keys this call site puts in `data`. THIS IS THE LEAK SURFACE: whatever
   * is listed here is available to every template token on every channel, and a
   * template that prints a key it should not is how the wrong person learns
   * something. `enrichTemplateData` adds the catalog's own merge fields on top;
   * those are listed separately in the DTO as `mergeFields`.
   */
  dataKeys: readonly string[];
  /**
   * Set only when the listed keys are not the whole story — a caller that
   * forwards an operator-supplied bag, for instance. An honest "and more",
   * rather than a fake key inside `dataKeys`.
   */
  dataNote?: string;
}

/** One outbound email that is NOT a catalog notification and so is NOT gated. */
export interface UngatedSend {
  /** The `emailTemplates/{id}` document that renders it. */
  templateId: string;
  /** What fires it, in business terms. */
  trigger: string;
  /** Where it lives, relative to mytribe/functions/. */
  source: string;
}

/**
 * The recipient rule, in plain words, for each resolver the catalog can name.
 * Mirrors `recipientResolver.ts` one-for-one; the drift guard asserts the two
 * cover the same set of resolvers.
 */
export const RECIPIENT_SENTENCES: Record<RecipientResolver, string> = {
  kinfolkAcct: "The household's own portal account: the kinfolk the event is about.",
  specificUid: 'One named person, chosen by whatever fired it.',
  businessAdmins:
    'Every business admin on the roster, one copy each (businessSettings/admins.uids).',
  auntieAssignedToKincare: 'The Auntie assigned to that visit, and only her.',
};

/**
 * Catalog key → every call site that dispatches it.
 *
 * A key with more than one entry really does have more than one trigger, and
 * the operator needs to see all of them: `invoice.payment.applied` fires from a
 * manual payment, from a Stripe webhook, AND from an invoice lifecycle change,
 * so silencing one path silences a third of the traffic.
 */
export const NOTIFICATION_EMITTERS: Record<string, readonly EmitterDescriptor[]> = {
  // ── Visits ──────────────────────────────────────────────────────────────
  'kincare.requested': [
    {
      trigger: 'A household requests a new visit (a booking is created as "requested").',
      source: 'src/triggers/onBookingsWrite.ts',
      dataKeys: ['kinfolkId', 'batchId', 'bookingId', 'visitId', 'serviceName', 'startTimeMs'],
    },
  ],
  'kincare.booking.confirm': [
    {
      trigger: 'A visit is confirmed or approved (its status changes to confirmed/approved).',
      source: 'src/triggers/onBookingsWrite.ts',
      dataKeys: ['kinfolkId', 'batchId', 'bookingId', 'visitId', 'serviceName', 'startTimeMs'],
    },
  ],
  'kincare.booking.cancel': [
    {
      trigger: 'A visit is cancelled (its status changes to cancelled).',
      source: 'src/triggers/onBookingsWrite.ts',
      dataKeys: ['kinfolkId', 'batchId', 'bookingId', 'visitId', 'serviceName', 'startTimeMs'],
    },
  ],
  'kincare.unavailable': [
    {
      trigger: 'A visit is marked unavailable (its status changes to unavailable).',
      source: 'src/triggers/onBookingsWrite.ts',
      dataKeys: ['kinfolkId', 'batchId', 'bookingId', 'visitId', 'serviceName', 'startTimeMs'],
    },
  ],
  'kincare.changed': [
    {
      trigger:
        'A confirmed visit is edited: one of the watched fields (date, time, service, Auntie) changes.',
      source: 'src/triggers/onBookingsWrite.ts',
      dataKeys: [
        'kinfolkId',
        'batchId',
        'bookingId',
        'visitId',
        'serviceName',
        'startTimeMs',
        'changedFields',
      ],
    },
  ],
  'kincare.cancel.requested': [
    {
      trigger: 'A household asks to cancel a visit (a cancel request is stamped on the booking).',
      source: 'src/triggers/onBookingsWrite.ts',
      dataKeys: [
        'kinfolkId',
        'batchId',
        'bookingId',
        'visitId',
        'serviceName',
        'startTimeMs',
        'reason',
      ],
    },
  ],
  'kincare.auntie.on_my_way': [
    {
      trigger: 'An Auntie taps "On my way" on a visit.',
      source: 'src/admin/dispatchVisitNotification.ts',
      dataKeys: [
        'familyId',
        'batchId',
        'bookingId',
        'visitId',
        'event',
        'serviceType',
        'scheduledAtMs',
        'auntieDisplayName',
        'recipientDisplayName',
        'etaMinutes',
      ],
    },
  ],
  'kincare.auntie.arrived': [
    {
      trigger: 'An Auntie taps "Arrived" on a visit.',
      source: 'src/admin/dispatchVisitNotification.ts',
      dataKeys: [
        'familyId',
        'batchId',
        'bookingId',
        'visitId',
        'event',
        'serviceType',
        'scheduledAtMs',
        'auntieDisplayName',
        'recipientDisplayName',
      ],
    },
  ],
  'kincare.auntie.departed': [
    {
      trigger: 'An Auntie taps "Departed" on a visit.',
      source: 'src/admin/dispatchVisitNotification.ts',
      dataKeys: [
        'familyId',
        'batchId',
        'bookingId',
        'visitId',
        'event',
        'serviceType',
        'scheduledAtMs',
        'auntieDisplayName',
        'recipientDisplayName',
        'reportPreviewUrl',
      ],
    },
  ],
  'kincare.note.kinfolk': [
    {
      trigger: 'A household member posts a note on a visit.',
      source: 'src/triggers/onBookingNoteCreate.ts',
      dataKeys: [
        'kinfolkId',
        'batchId',
        'bookingId',
        'visitId',
        'noteId',
        'authorUid',
        'preview',
      ],
    },
  ],
  'kincare.note.auntie': [
    {
      trigger: 'An Auntie posts a note on a visit.',
      source: 'src/triggers/onBookingNoteCreate.ts',
      dataKeys: [
        'kinfolkId',
        'batchId',
        'bookingId',
        'visitId',
        'noteId',
        'authorUid',
        'preview',
      ],
    },
  ],
  'kincare.upcoming.reminder': [
    {
      trigger: 'The nightly reminder sweep finds a visit coming up soon.',
      source: 'src/scheduled/kincareReminderCron.ts',
      dataKeys: ['kinfolkId', 'bookingId', 'serviceName', 'startTimeMs'],
    },
  ],
  'assignment.assigned': [
    {
      trigger: 'An Auntie is assigned to a visit that had nobody on it.',
      source: 'src/triggers/onBookingsWrite.ts',
      dataKeys: [
        'kinfolkId',
        'batchId',
        'bookingId',
        'visitId',
        'serviceName',
        'startTimeMs',
        'assignedAuntieUid',
      ],
    },
  ],
  'assignment.changed': [
    {
      trigger:
        'A visit an Auntie is on changes under her: reassigned away, unassigned, cancelled, or edited.',
      source: 'src/triggers/onBookingsWrite.ts',
      dataKeys: [
        'kinfolkId',
        'batchId',
        'bookingId',
        'visitId',
        'serviceName',
        'startTimeMs',
        'assignedAuntieUid',
        'changeKind',
        'changedFields',
      ],
    },
  ],
  'schedule.upcoming.digest': [
    {
      trigger: 'The schedule digest cron rolls up the next window of visits.',
      source: 'src/scheduled/scheduleDigestCron.ts',
      dataKeys: ['windowStartMs', 'windowEndMs', 'count', 'items'],
    },
  ],

  // ── KinTales ────────────────────────────────────────────────────────────
  'kintale.published': [
    {
      trigger: 'A KinTale is created already published.',
      source: 'src/triggers/onKinTaleCreate.ts',
      dataKeys: ['kinfolkId', 'taleId', 'authorDisplayName'],
    },
    {
      trigger: 'A draft KinTale is published.',
      source: 'src/triggers/onKinTaleUpdate.ts',
      dataKeys: ['kinfolkId', 'taleId', 'authorDisplayName'],
    },
    {
      // THE EASY ONE TO MISS. `dispatchVisitNotification` maps its `report_sent`
      // event to `kincare.report.sent`, which is a RETIRED key: the alias table
      // canonicalizes it onto this row. So an Auntie sending the visit report
      // fires kintale.published, and a reader who only looked for the literal
      // string in the source would never find this third trigger.
      trigger: 'An Auntie sends the visit report (through the retired kincare.report.sent key).',
      source: 'src/admin/dispatchVisitNotification.ts',
      dataKeys: [
        'familyId',
        'batchId',
        'bookingId',
        'visitId',
        'event',
        'serviceType',
        'scheduledAtMs',
        'auntieDisplayName',
        'recipientDisplayName',
        'reportPreviewUrl',
      ],
    },
  ],
  'kintale.comment.added': [
    {
      trigger: 'Someone comments on a KinTale.',
      source: 'src/triggers/onKinTaleCommentCreate.ts',
      dataKeys: ['kinfolkId', 'taleId', 'commentId', 'authorUid', 'authorRole', 'preview'],
    },
  ],
  'kintale.note.added': [
    {
      trigger: 'An already-published KinTale gains new text or new photos.',
      source: 'src/triggers/onKinTaleUpdate.ts',
      dataKeys: [
        'kinfolkId',
        'taleId',
        'authorDisplayName',
        'bodyChanged',
        'mediaAdded',
        'addedMediaCount',
      ],
    },
  ],

  // ── Money ───────────────────────────────────────────────────────────────
  'invoice.new': [
    {
      trigger: 'An admin creates an invoice.',
      source: 'src/admin/createInvoice.ts',
      dataKeys: ['kinfolkId', 'invoiceId'],
    },
    {
      trigger: 'An admin issues a quote (quotes ride the invoice.new key; data carries isQuote).',
      source: 'src/admin/createQuote.ts',
      dataKeys: ['kinfolkId', 'invoiceId', 'isQuote'],
    },
    {
      trigger: 'An admin reviews a draft invoice and sends it.',
      source: 'src/admin/reviewAndSendDraftInvoice.ts',
      dataKeys: ['kinfolkId', 'invoiceId'],
    },
    {
      trigger: 'An admin posts an invoice event for an invoice that had none yet.',
      source: 'src/admin/postInvoiceEvent.ts',
      dataKeys: ['kinfolkId', 'invoiceId'],
    },
  ],
  'invoice.updated': [
    {
      trigger: 'An admin posts an invoice event on an invoice that was already sent.',
      source: 'src/admin/postInvoiceEvent.ts',
      dataKeys: ['kinfolkId', 'invoiceId'],
    },
  ],
  'invoice.receipt': [
    {
      trigger: 'A receipt PDF is generated for a paid invoice.',
      source: 'src/admin/generateReceipt.ts',
      dataKeys: ['kinfolkId', 'invoiceId'],
    },
  ],
  'invoice.reminder': [
    {
      trigger: 'An admin presses "Send reminder" on an invoice.',
      source: 'src/admin/sendInvoiceReminder.ts',
      dataKeys: ['kinfolkId', 'invoiceId', 'invoiceDueDate', 'amountMinor', 'currency'],
    },
    {
      trigger: 'The nightly invoice sweep finds an invoice due soon.',
      source: 'src/scheduled/invoiceRemindersCron.ts',
      dataKeys: ['kinfolkId', 'invoiceId', 'invoiceDueDate', 'amountMinor', 'currency'],
    },
  ],
  'invoice.overdue': [
    {
      trigger: 'The nightly invoice sweep finds an invoice past its due date.',
      source: 'src/scheduled/invoiceRemindersCron.ts',
      dataKeys: [
        'kinfolkId',
        'invoiceId',
        'invoiceDueDate',
        'amountMinor',
        'currency',
        'daysPastDue',
      ],
    },
    {
      trigger: 'An invoice document moves into the past-due lifecycle state.',
      source: 'src/triggers/onInvoicesWrite.ts',
      dataKeys: ['kinfolkId', 'invoiceId', 'amountDue', 'currency', 'dueDate'],
    },
  ],
  'invoice.payment.applied': [
    {
      trigger: 'An admin records a payment against an invoice.',
      source: 'src/admin/recordPayment.ts',
      dataKeys: ['kinfolkId', 'invoiceId', 'paymentId'],
    },
    {
      trigger: 'Stripe reports a payment succeeded.',
      source: 'src/billing/stripeWebhook.ts',
      dataKeys: ['kinfolkId', 'invoiceId', 'stripeEventId'],
    },
    {
      trigger: 'An invoice document moves into the paid lifecycle state.',
      source: 'src/triggers/onInvoicesWrite.ts',
      dataKeys: ['kinfolkId', 'invoiceId', 'amountDue', 'currency', 'dueDate'],
    },
  ],
  'invoice.charge.failed': [
    {
      trigger: 'Stripe reports a charge failed.',
      source: 'src/billing/stripeWebhook.ts',
      dataKeys: ['kinfolkId', 'invoiceId', 'stripeEventId'],
    },
  ],
  'invoice.payment.disputed': [
    {
      trigger: 'Stripe opens or updates a dispute (chargeback) on a payment.',
      source: 'src/billing/stripeDispute.ts',
      dataKeys: [
        'kinfolkId',
        'invoiceId',
        'disputeId',
        'disputeStatus',
        'disputeReason',
        'disputeAmount',
        'stripeEventId',
      ],
    },
  ],

  // ── Household, account, messages ────────────────────────────────────────
  'message.received': [
    {
      trigger: 'A household sends a message from the portal.',
      source: 'src/portal/sendKinfolkMessage.ts',
      dataKeys: ['kinfolkId', 'kinfolkName', 'messageId', 'preview'],
    },
  ],
  'pets.updated': [
    {
      trigger:
        "A kin's record changes in a way the household can see (staff-only mirror edits are suppressed).",
      source: 'src/triggers/onFamilyKinWrite.ts',
      dataKeys: ['kinfolkId', 'kinId'],
    },
  ],
  'pet.marked.inactive': [
    {
      trigger: 'A kin is moved to an inactive status (rehomed, deceased, archived).',
      source: 'src/triggers/onFamilyKinWrite.ts',
      dataKeys: ['kinfolkId', 'kinId', 'kinName', 'status'],
    },
  ],
  'profile.updated': [
    {
      trigger: "A household's profile document is edited.",
      source: 'src/triggers/onFamilyProfileWrite.ts',
      dataKeys: ['kinfolkId'],
    },
  ],
  'account.welcome.kinfolk': [
    {
      trigger: 'An invited household member accepts their invite and finishes setup.',
      source: 'src/membership/acceptInvite.ts',
      dataKeys: ['kinfolkId', 'invitedEmail', 'role'],
    },
  ],
  'account.welcome.business': [
    {
      trigger: 'An invited household member accepts their invite. This is the office copy.',
      source: 'src/membership/acceptInvite.ts',
      dataKeys: ['kinfolkId', 'invitedEmail', 'role'],
    },
    {
      trigger: 'An admin grants a portal account its kinfolk claim by hand.',
      source: 'src/admin/setKinfolkClaim.ts',
      dataKeys: ['kinfolkId', 'kinfolkUid', 'actorUid'],
    },
  ],
  'invite.expired': [
    {
      trigger: 'The invite sweep expires an invite nobody accepted.',
      source: 'src/scheduled/expireStaleInvites.ts',
      dataKeys: ['kinfolkId', 'inviteId', 'invitedEmail'],
    },
  ],

  // ── Ratings ─────────────────────────────────────────────────────────────
  'rating.submitted.bad': [
    {
      trigger: 'A household leaves a rating at or below the bad-rating threshold.',
      source: 'src/triggers/onRatingCreate.ts',
      dataKeys: ['kinfolkId', 'ratingId', 'bookingId', 'score', 'comment', 'submittedByUid'],
    },
  ],
  'rating.submitted.good': [
    {
      trigger: 'A household leaves a rating above the bad-rating threshold.',
      source: 'src/triggers/onRatingCreate.ts',
      dataKeys: ['kinfolkId', 'ratingId', 'bookingId', 'score', 'comment', 'submittedByUid'],
    },
  ],

  // ── Security and auth ───────────────────────────────────────────────────
  'auth.password.reset': [
    {
      trigger: 'Someone asks for a password reset link.',
      source: 'src/auth/requestPasswordReset.ts',
      dataKeys: ['link', 'email', 'displayName'],
    },
  ],
  'auth.failedLogin.attempts': [
    {
      trigger: 'Failed sign-ins on one account cross the warning threshold.',
      source: 'src/auth/loginSecurity.ts',
      dataKeys: ['email', 'attemptsInWindow'],
    },
  ],
  'auth.account.locked': [
    {
      trigger:
        'Failed sign-ins lock an account. One copy goes to the locked-out person, one to each operator uid in AUNTIE_OPERATOR_UIDS.',
      source: 'src/auth/loginSecurity.ts',
      dataKeys: ['email', 'lockStartedAtMs', 'kinfolkUid'],
    },
  ],
  'security.breach_attempt.kinfolk': [
    {
      trigger: 'A secure-reset confirmation is attempted against an account that did not ask.',
      source: 'src/security/confirmSecureReset.ts',
      dataKeys: ['kinfolkEmail', 'timestampIso', 'ip', 'userAgent', 'incidentId'],
    },
  ],

  // ── Marketing ───────────────────────────────────────────────────────────
  'newsletter.announcement': [
    {
      trigger: 'An admin schedules a marketing blast on the newsletter key.',
      source: 'src/admin/scheduleMarketingBlast.ts',
      dataKeys: ['audienceUid'],
      dataNote: 'Plus every field the blast form itself sends, verbatim.',
    },
  ],
  'survey.event': [
    {
      trigger: 'An admin schedules a marketing blast on the survey key.',
      source: 'src/admin/scheduleMarketingBlast.ts',
      dataKeys: ['audienceUid'],
      dataNote: 'Plus every field the blast form itself sends, verbatim.',
    },
  ],
  'marketing.optin': [
    {
      trigger: 'An admin schedules a marketing blast on the opt-in key.',
      source: 'src/admin/scheduleMarketingBlast.ts',
      dataKeys: ['audienceUid'],
      dataNote: 'Plus every field the blast form itself sends, verbatim.',
    },
  ],
};

/**
 * Catalog rows that no code dispatches. They are real rows with real templates
 * and real toggles, and toggling them changes nothing, because nothing calls
 * `enqueueNotification` with these keys.
 *
 * `createQuote.ts` mentions both in a comment explaining that quotes ride
 * `invoice.new` instead; that comment is the closest thing to an accept/deny
 * emitter that exists. The gate screen badges these rows "Never fires" so the
 * operator stops treating their state as a control.
 */
export const NEVER_FIRES: readonly string[] = ['quote.accepted', 'quote.denied'];

/**
 * Email the platform sends that the notification gate does NOT govern.
 *
 * These go out through `sendFromTemplate`, straight to an address, with no
 * catalog row, no channel resolution and no recipient preference. Every toggle
 * on the gate screen is irrelevant to them. They are listed so the answer to
 * "what could be sent out to users" is the whole answer and not just the part
 * that happens to be gated.
 *
 * `broadcastMessage` and `sendExternalMessage` are deliberately NOT here: they
 * render operator-authored bodies rather than a fixed template id, and #386 is
 * separately giving broadcast a catalog row of its own. When that lands, this
 * list is unaffected.
 */
export const UNGATED_SENDS: readonly UngatedSend[] = [
  {
    templateId: 'invite.primary',
    trigger: 'A tribe is provisioned, an invite is minted, or a household is invited to the portal.',
    source: 'src/admin/inviteKinfolkToPortal.ts',
  },
  {
    templateId: 'invite.primary',
    trigger: 'An admin mints an invite by hand.',
    source: 'src/admin/mintInvite.ts',
  },
  {
    templateId: 'invite.primary',
    trigger: 'A new tribe is provisioned and its primary is invited.',
    source: 'src/admin/provisionTribe.ts',
  },
  {
    templateId: 'invite.secondary',
    trigger: 'A household primary invites a second member.',
    source: 'src/membership/mintInviteFromPrimary.ts',
  },
  {
    templateId: 'invite.auntie-notify',
    trigger: 'A household primary invites a second member, and the office is copied.',
    source: 'src/membership/mintInviteFromPrimary.ts',
  },
  {
    templateId: 'invite.primary-receipt',
    trigger: 'A household primary invites a second member, and the primary gets a receipt.',
    source: 'src/membership/mintInviteFromPrimary.ts',
  },
  {
    templateId: 'invite.verify-email',
    trigger: 'An invite is accepted and the address needs verifying.',
    source: 'src/membership/acceptInvite.ts',
  },
  {
    templateId: 'recovery.requested',
    trigger: 'A household asks to recover its primary account.',
    source: 'src/recovery/requestPrimaryRecovery.ts',
  },
  {
    templateId: 'recovery.completed',
    trigger: 'An admin completes a primary-account recovery.',
    source: 'src/admin/executePrimaryRecovery.ts',
  },
  {
    templateId: 'error.daily-digest',
    trigger: 'The daily error digest cron runs.',
    source: 'src/scheduled/errorDailyDigest.ts',
  },
];

/**
 * The recipient rule for one catalog row, as one sentence per resolver.
 *
 * Two sentences when the row has a `secondaryResolver`, because that is a row
 * that notifies two different sets of people from a single event and reading
 * only the first sentence is how someone concludes a message stays inside the
 * household when it also lands in the office.
 */
export function whoReceives(def: NotificationDef): string[] {
  const out = [RECIPIENT_SENTENCES[def.recipientResolver]];
  if (def.secondaryResolver && def.secondaryResolver !== def.recipientResolver) {
    out.push(RECIPIENT_SENTENCES[def.secondaryResolver]);
  }
  return out;
}
