import { getAdmin, db } from '../../lib/firestoreAdmin';
import { logEvent } from '../../lib/logger';
import {
  HOUSEHOLD_NOTICE_ROUTE,
  householdPushLineIsCut,
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
 * The field on a household's `notifications/{id}` entry that holds the whole
 * message its push was cut from (#2368). Plain text as rendered, never HTML;
 * `listMyNotifications` hands it to the list as `fullMessage`.
 */
export const HOUSEHOLD_MESSAGE_FIELD = 'householdMessage';
/**
 * The same for a cut text message (#2371). Its own field, because the text
 * message is rendered from its own template and both senders run at the same
 * time: one shared field would hold whichever finished last.
 */
export const HOUSEHOLD_TEXT_MESSAGE_FIELD = 'householdTextMessage';
/**
 * Writes the whole message onto the household's entry, for the push sender and
 * the text sender (`smsChannel.ts`). `update`, not a merge: an entry the office
 * took back since (#2038) stays gone instead of coming back as a stub. A
 * refused write is logged and the message still goes; the entry then reads as
 * it did before, its facts line.
 */
export async function keepWholeMessage(
  channel: 'push' | 'sms',
  entryId: string,
  message: string,
  key: string,
): Promise<void> {
  const field = channel === 'push' ? HOUSEHOLD_MESSAGE_FIELD : HOUSEHOLD_TEXT_MESSAGE_FIELD;
  try {
    await db().collection('notifications').doc(entryId).update({ [field]: message.trim() });
  } catch (err) {
    logEvent({
      severity: 'error',
      function: channel === 'push' ? 'pushChannel' : 'smsChannel',
      event: `notification.${channel}.message_not_kept`,
      extra: { key, entryId, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Push channel sender (FCM via firebase-admin). Reads `pushTemplates/{key}`
 * for `title` + `body` + optional `dataRoute` deep-link, queries
 * `fcm_tokens` for all device tokens owned by recipientUid, multicasts via
 * `messaging().sendEachForMulticast`, and prunes tokens FCM reports as invalid.
 *
 * A HOUSEHOLD'S COPY IS SHORT AND OPENS MYTRIBE (#2280, operator ruling
 * 2026-11-14): the body is cut to `HOUSEHOLD_SHORT_LINE_MAX` and the payload
 * always carries a `route`. A push whose line was cut, or whose notice carries
 * the office's note, opens the notifications list at that notice's entry,
 * where the whole message is. Any other opens the template's own route, else
 * the thing the notice is about (#2259), else the notifications list. Both
 * MyTribe clients follow that route. Every other copy carries its target as
 * plain data keys (#2100), which the Android apps open from.
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
  // Ruling 2026-11-14: the short line links to the full message. A line that
  // was cut, or a notice with the office's note on it, is read whole on the
  // notifications list, at its own entry. That wins over every other route,
  // and the target fields are left off so the Android app follows the route
  // too (it would otherwise open the target from them).
  const cut = household && householdPushLineIsCut(renderedBody);
  const readInList =
    household && open?.readInList !== undefined && (cut || open.officeNote === true)
      ? open.readInList
      : undefined;
  // #2368: the entry the tap opens has to hold the rest of a cut line. Only
  // this sender has the message as rendered, so it writes it onto the entry,
  // before the push goes, so a tap never lands ahead of it.
  if (cut && readInList?.entryId) await keepWholeMessage('push', readInList.entryId, renderedBody, def.key);
  const dataRoute = readInList
    ? readInList.route
    : templateRoute || (household ? open?.route || HOUSEHOLD_NOTICE_ROUTE : undefined);

  const dataPayload: Record<string, string> = {
    // #2100: the target fields first, so the two keys below can never be
    // overwritten by them.
    ...(readInList ? {} : (open?.data ?? {})),
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
