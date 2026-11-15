import { getAdmin, db } from '../../lib/firestoreAdmin';
import { logEvent } from '../../lib/logger';
import {
  HOUSEHOLD_NOTICE_ROUTE,
  householdPushShelfLine,
  kinForStoredTemplate,
  renderPlainText,
} from '../templateParsers';
import { fallbackPush } from '../fallbackTemplate';
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
 * A HOUSEHOLD'S COPY IS SHORT AND OPENS MYTRIBE (#2280, operator ruling
 * 2026-11-14): the body is cut to `HOUSEHOLD_SHORT_LINE_MAX` and the payload
 * always carries a `route`: the template's own, else the thing the notice is
 * about (#2259), else the notifications list. The web portal's service worker
 * opens that route on a tap. Every copy also carries its target as plain data
 * keys (#2100), which the Android apps open from.
 *
 * Returns the message id of the first successful send, or throws if every
 * token failed (fail-loud per project policy).
 *
 * Token cleanup: any token returning `messaging/registration-token-not-registered`
 * or `messaging/invalid-registration-token` is deleted to keep `fcm_tokens` clean.
 */
export async function sendPushChannel(args: ChannelSendArgs): Promise<ChannelSendResult> {
  const { def, recipientUid, data, stream, open } = args;
  const templateId = def.templates.push;
  if (!templateId) {
    throw new Error(`pushChannel(${def.key}): catalog has no push template id`);
  }

  const tplSnap = await db().doc(`pushTemplates/${templateId}`).get();
  const stored = tplSnap.exists ? (tplSnap.data() as PushTemplate) : null;

  // A missing document, or one whose title/body was never filled in, means the
  // operator has not authored this copy yet. Push is a doorbell rather than the
  // message even when the template DOES exist, so generic wording costs almost
  // nothing here: tapping it lands on the real thing either way. Logged at
  // `error` and stamped on the result, so it is disclosed and never silent.
  // See notifications/fallbackTemplate.ts for why this is not a throw.
  const missingCopy = !stored?.title || !stored.body;
  if (missingCopy) {
    logEvent({
      severity: 'error',
      function: 'pushChannel',
      event: 'notification.template.missing',
      extra: {
        key: def.key,
        channel: 'push',
        templateId,
        reason: tplSnap.exists ? 'title/body empty' : 'document missing',
        action: 'sent generic wording; author this template in the Template Bank',
      },
    });
  }
  const generic = fallbackPush(def);
  const tpl: PushTemplate = missingCopy
    ? { title: generic.title, body: generic.body, dataRoute: stored?.dataRoute }
    : stored;

  const tokensSnap = await db().collection('fcm_tokens').where('uid', '==', recipientUid).get();
  const tokens = tokensSnap.docs.map((d) => d.id);
  if (tokens.length === 0) {
    throw new Error(`pushChannel(${def.key}): recipient ${recipientUid} has no registered fcm tokens`);
  }

  // #2093: a template stored before the quote wording changed still reads whole.
  const renderCtx = { ...kinForStoredTemplate(data, [tpl.title, tpl.body]), recipientUid, notificationKey: def.key };
  // #2321: a push is plain text and its route is a path, so nothing is escaped
  // for a web page.
  // Both are set by here: a template missing either was swapped for the
  // generic wording above.
  const title = renderPlainText(tpl.title ?? '', renderCtx);
  const renderedBody = renderPlainText(tpl.body ?? '', renderCtx);
  const templateRoute = tpl.dataRoute ? renderPlainText(tpl.dataRoute, renderCtx) : undefined;
  // #2280: a household's push is a short line, and a tap on it opens MyTribe.
  // #2259: it opens the thing the notice is about (the visit, the KinTale, the
  // Kin, the invoice), where the whole message is read in place. The
  // template's own route wins when it has one; a notice that names nothing to
  // open lands on the notifications list. Staff and business copies are sent
  // as written, with no route: the admin apps open from the target fields.
  const household = stream === 'kinfolk';
  const body = household ? householdPushShelfLine(renderedBody) : renderedBody;
  const dataRoute = templateRoute || (household ? open?.route || HOUSEHOLD_NOTICE_ROUTE : undefined);

  const dataPayload: Record<string, string> = {
    // #2100: the target fields first, so the two keys below can never be
    // overwritten by them.
    ...(open?.data ?? {}),
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

  return missingCopy
    ? {
        providerMessageId: firstSuccessId,
        usedFallback: true,
        fallbackReason: `pushTemplates/${templateId}`,
      }
    : { providerMessageId: firstSuccessId };
}
