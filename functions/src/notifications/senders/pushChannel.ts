import Handlebars from 'handlebars';
import { getAdmin, db } from '../../lib/firestoreAdmin';
import { stripUnresolvedTokens } from '../templateParsers';
import type { ChannelSendArgs, ChannelSendResult } from './index';

interface PushTemplate {
  title?: string;
  body?: string;
  dataRoute?: string;
}

/**
 * Push channel sender (FCM via firebase-admin). Reads `pushTemplates/{key}`
 * for `title` + `body` + optional `dataRoute` deep-link, queries
 * `fcm_tokens` for all device tokens owned by recipientUid, multicasts via
 * `messaging().sendEachForMulticast`, and prunes tokens FCM reports as invalid.
 *
 * Returns the message id of the first successful send, or throws if every
 * token failed (fail-loud per project policy).
 *
 * Token cleanup: any token returning `messaging/registration-token-not-registered`
 * or `messaging/invalid-registration-token` is deleted to keep `fcm_tokens` clean.
 */
export async function sendPushChannel(args: ChannelSendArgs): Promise<ChannelSendResult> {
  const { def, recipientUid, data } = args;
  const templateId = def.templates.push;
  if (!templateId) {
    throw new Error(`pushChannel(${def.key}): catalog has no push template id`);
  }

  const tplSnap = await db().doc(`pushTemplates/${templateId}`).get();
  if (!tplSnap.exists) {
    throw new Error(`pushChannel(${def.key}): pushTemplates/${templateId} missing`);
  }
  const tpl = tplSnap.data() as PushTemplate;
  if (!tpl.title || !tpl.body) {
    throw new Error(`pushChannel(${def.key}): pushTemplates/${templateId} requires title + body`);
  }

  const tokensSnap = await db().collection('fcm_tokens').where('uid', '==', recipientUid).get();
  const tokens = tokensSnap.docs.map((d) => d.id);
  if (tokens.length === 0) {
    throw new Error(`pushChannel(${def.key}): recipient ${recipientUid} has no registered fcm tokens`);
  }

  const renderCtx = { ...data, recipientUid, notificationKey: def.key };
  const title = stripUnresolvedTokens(Handlebars.compile(tpl.title)(renderCtx));
  const body = stripUnresolvedTokens(Handlebars.compile(tpl.body)(renderCtx));
  const dataRoute = tpl.dataRoute
    ? stripUnresolvedTokens(Handlebars.compile(tpl.dataRoute)(renderCtx))
    : undefined;

  const dataPayload: Record<string, string> = {
    notificationKey: def.key,
  };
  if (dataRoute) dataPayload['route'] = dataRoute;

  const response = await getAdmin()
    .messaging()
    .sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: dataPayload,
    });

  const stalePrune: Promise<unknown>[] = [];
  let firstSuccessId: string | undefined;
  response.responses.forEach((resp, idx) => {
    const token = tokens[idx];
    if (resp.success) {
      if (!firstSuccessId && resp.messageId) firstSuccessId = resp.messageId;
    } else if (
      resp.error?.code === 'messaging/registration-token-not-registered' ||
      resp.error?.code === 'messaging/invalid-registration-token'
    ) {
      if (token) stalePrune.push(db().collection('fcm_tokens').doc(token).delete());
    }
  });
  if (stalePrune.length > 0) await Promise.allSettled(stalePrune);

  if (response.successCount === 0) {
    const firstErr = response.responses.find((r) => !r.success)?.error;
    throw new Error(
      `pushChannel(${def.key}): all ${tokens.length} sends failed${
        firstErr ? `; first error: ${firstErr.code} ${firstErr.message}` : ''
      }`,
    );
  }

  return { providerMessageId: firstSuccessId };
}
