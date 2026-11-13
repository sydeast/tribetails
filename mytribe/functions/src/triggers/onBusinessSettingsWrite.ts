import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import {
  BUSINESS_PUBLIC_CARD_DOC,
  BUSINESS_SETTINGS_SOURCE_DOC,
  buildBusinessPublicCard,
  sameBusinessPublicCard,
} from '../lib/businessPublicCard';

/**
 * #1321: keeps `business_public/card` equal to the public projection of
 * `business_settings/business_settings`.
 *
 * The settings document is written straight from three admin clients with no
 * callable in front (see the `business_settings` rules), so a trigger is the
 * one hook that sees every edit. Each write rebuilds the card from the whole
 * `after` document through `buildBusinessPublicCard`, the closed field list, and
 * REPLACES the mirror (`set` without merge) so a field the operator blanks is
 * blanked on the card too.
 *
 * NO WRITE WHEN NOTHING PUBLIC CHANGED. The document carries some fifty fields
 * and most saves touch none of the four this mirrors; comparing against the
 * stored card (rather than against `before`) also means the first run after
 * deploy creates the card from whatever settings already say, and a card
 * someone deleted by hand comes back on the next save.
 *
 * A deleted settings document writes an all-blank card: the clients omit the
 * "by ..." line on a blank name, and never invent one.
 */
async function mirrorPublicCard(after: Record<string, unknown> | undefined): Promise<void> {
  const card = buildBusinessPublicCard(after);

  const ref = db().doc(BUSINESS_PUBLIC_CARD_DOC);
  const stored = (await ref.get()).data() as Record<string, unknown> | undefined;
  if (sameBusinessPublicCard(stored, card)) return;

  await ref.set(card);
  logEvent({
    severity: 'info',
    function: 'onBusinessSettingsWrite',
    event: 'business.publicCard.mirrored',
    extra: { nameSet: card.name !== '', phoneSet: card.phone !== '', privacyPolicySet: card.privacyPolicyUrl !== '' },
  });
}

/**
 * #2123: "KinTale required" off clears the Auntie's "Send the KinTale" tasks.
 * Every admin client lists those tasks from the visit's `kinTaleDue` stamp
 * alone, with no settings read (an Auntie cannot read this document), so the
 * stamps have to go when the switch does.
 *
 * WHY HERE AND NOT IN `saveBusinessSettings`. This trigger runs after the
 * settings write has COMMITTED and for every writer of the document, so there is
 * no state where the save failed and the tasks were cleared anyway, or where a
 * writer other than the callable turns the switch off and leaves them standing.
 *
 * WHY ON EVERY WRITE WHILE OFF, not only on the on-to-off edge. The clear is
 * idempotent and, with nothing stamped, it is one empty query. Running it on
 * every save while the switch is off makes it self-healing: a run that failed
 * (this trigger has no retry), or a hand-marked completion whose own re-check
 * of the switch failed, is cleared by the next settings save instead of
 * standing for good. The departure trigger reads the switch inside its own
 * transaction, so a visit it completes cannot interleave with the switch-off.
 *
 * Turning the switch back on clears nothing and stamps nothing: only visits
 * completed from then on are stamped.
 *
 * THE STORED SWITCH, NOT ONLY THE EVENT'S. Trigger events are not delivered in
 * order, so an "off" event handled after the owner switched it back on would
 * wipe tasks the switch now owes, and nothing re-stamps them. The clear runs
 * only when the event AND the document as it stands both read off. A failed
 * read clears nothing.
 *
 * The other `transitionBookingStatus` window (its switch read is outside a
 * transaction) is closed there: it re-reads the switch after its write lands.
 */
async function clearTasksWhileOff(after: Record<string, unknown> | undefined): Promise<void> {
  // Loaded here, not at file scope: see coldStartImportGraph.test.ts.
  const { clearKinTalesDue, kinTaleRequiredFrom } = await import('../lib/kinTaleRequirement.js');
  if (kinTaleRequiredFrom(after)) return;
  const stored = (await db().doc(BUSINESS_SETTINGS_SOURCE_DOC).get()).data() as Record<string, unknown> | undefined;
  if (kinTaleRequiredFrom(stored)) return;
  const cleared = await clearKinTalesDue(db());
  if (cleared === 0) return;
  logEvent({
    severity: 'info',
    function: 'onBusinessSettingsWrite',
    event: 'kinTale.tasks.cleared',
    extra: { cleared },
  });
}

export const onBusinessSettingsWrite = onDocumentWritten(
  {
    document: BUSINESS_SETTINGS_SOURCE_DOC,
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onBusinessSettingsWrite', async (event) => {
    const after = event.data?.after.data() as Record<string, unknown> | undefined;
    // Two independent jobs: one failing must not stop the other. The first
    // failure is still thrown, so the wrapper reports it.
    const results = await Promise.allSettled([mirrorPublicCard(after), clearTasksWhileOff(after)]);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }),
);
