/**
 * Seeds Firestore with hello-world stubs for every notification template the
 * catalog references (`emailTemplates/{key}`, `smsTemplates/{key}`,
 * `pushTemplates/{key}`). Lets the dispatcher + channel senders run end-to-end
 * smoke tests without manual template authoring.
 *
 * Run:
 *   GCLOUD_PROJECT=auntieos-ttpc \
 *     ts-node --project scripts/tsconfig.json scripts/seedHelloWorldNotificationTemplates.ts
 *
 * Requires ambient application-default credentials (either
 * `gcloud auth application-default login` or a service-account key
 * referenced via GOOGLE_APPLICATION_CREDENTIALS).
 */
import { initializeApp, getFirestore, FieldValue } from './lib/firebaseAdmin';
import { NOTIFICATION_CATALOG } from '../functions/src/notifications/catalog';

async function main(): Promise<void> {
  if (!process.env.GCLOUD_PROJECT) {
    throw new Error('GCLOUD_PROJECT env required (e.g. auntieos-ttpc)');
  }
  initializeApp({ projectId: process.env.GCLOUD_PROJECT });
  const db = getFirestore();
  const ts = FieldValue.serverTimestamp();
  let count = 0;

  for (const def of Object.values(NOTIFICATION_CATALOG)) {
    const isMarketing = !!def.marketingCategory;
    const unsubFooter = isMarketing
      ? '\n\nUnsubscribe: {{unsubscribeUrl}}'
      : '';

    if (def.allowedChannels.includes('email') && def.templates.email) {
      await db.doc(`emailTemplates/${def.templates.email}`).set(
        {
          subject: `[hello-world] ${def.key}`,
          body: `Placeholder email body for ${def.key}. Recipient: {{recipientUid}}.${unsubFooter}`,
          html: null,
          stub: true,
          updatedAt: ts,
        },
        { merge: true },
      );
      count += 1;
    }
    if (def.allowedChannels.includes('sms') && def.templates.sms) {
      await db.doc(`smsTemplates/${def.templates.sms}`).set(
        {
          text: `[hello-world] ${def.key} for {{recipientUid}}`,
          stub: true,
          updatedAt: ts,
        },
        { merge: true },
      );
      count += 1;
    }
    if (def.allowedChannels.includes('push') && def.templates.push) {
      await db.doc(`pushTemplates/${def.templates.push}`).set(
        {
          title: `[hello-world] ${def.key}`,
          body: `Placeholder push body for ${def.key}.`,
          dataRoute: `/notifications/${def.key}`,
          stub: true,
          updatedAt: ts,
        },
        { merge: true },
      );
      count += 1;
    }
  }

  console.log(`Seeded ${count} hello-world templates across email/sms/push.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
