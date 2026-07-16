import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { wrapTrigger } from '../lib/wrapTrigger';

export const onInviteRequestCreate = onDocumentCreated(
  { document: 'inviteRequests/{id}', secrets: ['SENTRY_DSN'] },
  wrapTrigger('onInviteRequestCreate', async () => {
    // Currently no-op: mintInvite paths send email inline.
    // Reserved for future templated dispatch alternative.
  }),
);
