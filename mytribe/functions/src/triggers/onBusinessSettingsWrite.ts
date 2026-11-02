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
export const onBusinessSettingsWrite = onDocumentWritten(
  {
    document: BUSINESS_SETTINGS_SOURCE_DOC,
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onBusinessSettingsWrite', async (event) => {
    const after = event.data?.after.data() as Record<string, unknown> | undefined;
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
  }),
);
