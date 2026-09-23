/**
 * THE ENTIRE SERVER-SIDE ADMIN/AUNTIE BOUNDARY, IN ONE LIST.
 *
 * Issue #944, operator ruling 2026-09-22. Spec:
 * docs/superpowers/specs/2026-09-22-admin-auntie-access-design.md
 *
 * An Auntie is a caretaker: a contractor or employee. She sees household
 * information because she cannot do the job without it, and she does not see
 * money, ever. Firestore rules enforce that for direct client reads and writes.
 * They enforce NOTHING for a callable, because a callable runs on the Admin
 * SDK, which does not evaluate rules at all. This file is the other half.
 *
 * WHY A TABLE RATHER THAN 135 EDITED CALL SITES. `wrapAdminCallable` already
 * takes the callable's name and already wraps 135 of them, so the boundary can
 * live in one place instead of being spread one line at a time across the
 * admin tree. Two things follow, and both are the point:
 *
 *   1. A reviewer reads ONE file to see everything an Auntie may invoke.
 *   2. ABSENT MEANS REFUSED. A callable nobody has thought about is owner-only,
 *      a typo in this list grants nothing rather than granting the wrong thing,
 *      and a callable added next month is owner-only until somebody opens it on
 *      purpose. The failure mode of forgetting is a support ticket, not a
 *      breach.
 *
 * HOW TO DECIDE A NEW ENTRY. Same procedure as the rules walk, first match wins:
 *   1. Does it touch invoices, payments, credits, balances, payouts, pricing or
 *      Stripe? Owner. This is the bright line and it has no exceptions.
 *   2. Does it read or write a dossier, or household_bank? Owner.
 *   3. Does it mint, revoke or list a claim, or edit staff/business config?
 *      Owner.
 *   4. Is it marketing, the business phone, security, or audit oversight? Owner.
 *   5. Does the Auntie's job require it: a household or kin record, a visit she
 *      works, a KinTale, media, a 411, the household conversation, her own
 *      schedule or her own notification preferences? Add it here.
 *   6. Destructive (delete, archive, bulk mutate)? Owner, even under 5.
 *   7. Anything else: leave it out, and add the callable to section 12 of the
 *      spec so the operator can rule on it.
 *
 * `test/auntieAccess.test.ts` asserts every name below is a callable this
 * codebase actually exports, so the set cannot rot into strings that gate
 * nothing.
 */

/**
 * The value of the `staffRole` custom claim that means "caretaker". The owner
 * carries `admin: true` and no `staffRole` at all; see `staffGate.ts`.
 */
export const STAFF_ROLE_AUNTIE = 'auntie';

/**
 * Callables an Auntie may invoke. Everything not listed is owner-only.
 *
 * Grouped by the reason, because the reason is what a reviewer is checking.
 */
export const AUNTIE_ALLOWED_CALLABLES: ReadonlySet<string> = new Set<string>([
  // ── KinTales: her core output ──────────────────────────────────────────
  // A KinTale itself is a direct client write governed by firestore.rules, not
  // a callable. These are the callables its lifecycle reaches for.
  'dispatchVisitNotification', // Android + desktop announce a send through this
  'createShareLink', // share a tale with someone outside the household
  'addKinTaleComment', // comments are write-closed in rules; this is the only path
  'getKinTaleComments',
  'listOrphanReports', // a tale that landed without a household
  'triageOrphanReport', // assign / mark duplicate / archive bad data
  'listTemplates',
  'listTemplateBindings',
  'listCategories',
  'listChecklistBank',
  'saveMediaTags', // which kin are in this photo
  'setMediaProfilePhoto',

  // ── Visits and her own schedule ────────────────────────────────────────
  'createKinCareSession',
  'updateKinCareSession',
  'setVisitLifecycle', // On my way / Arrived / Departed, the in-visit clock
  'verifyVisitArrival',
  'listPendingBookingRequests', // the Incoming-requests queue
  'createBlockedTimeSlot', // her own availability
  'deleteBlockedTimeSlot',
  'optimizeRoute',
  'getLocalWeather',

  // ── The households she serves ──────────────────────────────────────────
  'listMembers',
  'saveEmergencyContacts',
  'listEmergencyContacts',
  'submitVetClinic', // propose a clinic; curating the catalog stays with the owner
  'addBookingNote',
  'addInternalBookingNote',

  // ── Talking to a household ─────────────────────────────────────────────
  // She is the counterparty on these threads, not an observer of them.
  'listConversations',
  'getConversationThread',
  'replyToConversation',
  'markConversationRead',
  'markAllThreadsRead',

  // ── Herself ────────────────────────────────────────────────────────────
  'getMyAdminNotificationPrefs',
  'saveMyAdminNotificationPrefs',
  'markNotificationRead',
  'archiveNotification',
  'bulkMarkNotificationsRead',
  'listStaff', // the Assigned Auntie picker renders from this
]);

/**
 * May an Auntie invoke this callable? Unknown name means no.
 *
 * Deliberately total and side-effect free: the gate reads this and nothing
 * else, so what an Auntie can reach is decidable by reading the set above.
 */
export function auntieMayCall(name: string): boolean {
  return AUNTIE_ALLOWED_CALLABLES.has(name);
}
