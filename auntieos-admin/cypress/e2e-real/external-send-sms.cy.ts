import { usingFixtureAdmin } from '../support/commands';
import { vendorConfigured } from '../support/e2e-real';

/**
 * A text through the real `sendExternalMessage` callable (`channel: 'sms'`)
 * on Twilio's TEST credentials (#1516, the Twilio row of #1089).
 *
 * THE ENTRY POINT. #1516 names `ExternalSendPanel`, but no screen in the React
 * admin mounts that component (#1518). The one shipped control that calls
 * `sendExternalMessage` with `channel: 'sms'` is the Inbox reply composer
 * (`components/ThreadActionsCard.tsx`): open a channel row that carries a phone
 * number, write a reply, press Send text. It is the same callable with the same
 * Twilio path, plus `mirrorToChannel: true`, which asks the server to list the
 * reply in the thread. Re-point this spec at the panel once #1518 is settled.
 *
 * THE NUMBERS (operator ruling D3, 2026-10-01). Sender and recipient are both
 * Twilio's documented magic test number. With test credentials Twilio
 * validates the request, returns a message SID and delivers nothing; the
 * preflight (`scripts/e2e-real/preflight.mjs`) already defaults
 * TWILIO_FROM_NUMBER to it. No number in the business or private line's area
 * code may appear anywhere in this file, and the preflight refuses the run if
 * one does.
 *
 * WHAT IS PROVED, FROM THE UI ONLY (2026-09-01 ruling):
 *   1. The card's "Reply sent" banner names the REDACTED recipient. That line
 *      is written from the server's answer, which it only gives after Twilio
 *      accepted the message; a refusal reaches the screen as "Something did
 *      not go through" instead. The banner also says the reply is listed below,
 *      which is the server reporting that its mirror write landed: the seeded
 *      inbound row makes the number a known counterpart, so the mirror is
 *      allowed (`lib/smsChannelMirror.ts`).
 *   2. After a reload, the Inbox channel list carries the reply as an outbound
 *      row (the mirror write, read back through the live `sms_messages`
 *      listener), marked "sent".
 *   3. On Communicate, the Recent panel lists the send as a Text to the
 *      redacted recipient with the state "Sent". That panel reads
 *      `external_messages` through `listRecentSends`, the record the callable
 *      writes after the provider accepted the message. "Sent" is the honest
 *      ceiling: "Delivered" needs the Twilio status webhook, which never fires
 *      on test credentials. Never assert on the Twilio response itself.
 *
 * The harness condition in `support/e2e-real.ts` still applies: a structured
 * `severity: error` line our functions log while the test runs fails it. A
 * Twilio refusal is logged that way by `wrapCallable`, naming Twilio, which is
 * what `classify-run.mjs` reads to attribute the failure (D3-e).
 *
 * SKIPS, WITH THE REASON IN THE LOG, when the run has no Twilio test
 * credentials. Absent credentials are never a pass and never a red run.
 */

const STAMP = Date.now().toString(36);
/** Twilio's magic test number: passes every validation, delivers nothing. */
const MAGIC_NUMBER = '+15005550006';
/** `redactRecipient` in mytribe/functions/src/lib/suppressions.ts: country code, stars, last four. */
const REDACTED = '+1******0006';
/** The seeded inbound text, keyed like `twilioInboundSms` keys its rows (by message SID). */
const INBOUND_ID = `SMe2ereal${STAMP}`;
const INBOUND_BODY = `Is Saturday still on? ref ${STAMP}`;
const REPLY_BODY = `Yes, Saturday is on. See you then. ref ${STAMP}`;

/**
 * SEND covers a real callable cold start plus one round trip to Twilio. A
 * user would wait for the same answer in production, in seconds.
 */
const BUDGET_MS = { RENDER: 15_000, SEND: 30_000 } as const;

describe('a text through sendExternalMessage (real callable, Twilio test credentials)', () => {
  before(function () {
    if (!usingFixtureAdmin()) this.skip();
    if (!vendorConfigured('twilio')) {
      cy.log('SKIPPED: no Twilio test credentials in this run (TWILIO_TEST_ACCOUNT_SID, TWILIO_TEST_AUTH_TOKEN)');
      this.skip();
    }
  });

  after(() => {
    // The seeded inbound row. The reply's mirror row (keyed by the Twilio SID,
    // which the screen never shows) and the `external_messages` record stay in
    // the run's emulator, which is discarded with the run.
    cy.task('deleteDoc', { collection: 'sms_messages', id: INBOUND_ID });
  });

  it('#1516 sends a reply from the Inbox through sendExternalMessage; after a reload it is in the thread and in Recent as Sent', () => {
    // The shape `twilioInboundSms` writes (mytribe/functions/src/twilio/twilioInbound.ts):
    // an ISO-string timestamp (the Inbox orders on it), `counterpartNumber` in
    // the clear (the mirror's thread lookup matches on it), no kinfolk match.
    cy.task('upsertDoc', {
      collection: 'sms_messages',
      id: INBOUND_ID,
      doc: {
        direction: 'inbound',
        subType: 'sms',
        status: 'received',
        twilioMessageSid: INBOUND_ID,
        counterpartNumber: MAGIC_NUMBER,
        body: INBOUND_BODY,
        mediaUrls: [],
        timestamp: new Date().toISOString(),
        kinfolkId: null,
        kinfolkName: '',
        threadId: '',
        reconcileStatus: 'pending',
        reconciledAt: '',
        reconcileNotes: '',
      },
    });

    cy.signIn();
    cy.visit('/inbox');
    cy.contains('.inbox__row--card', INBOUND_BODY, { timeout: BUDGET_MS.RENDER })
      .find('button.inbox__row-main')
      .click();

    cy.get('[role="dialog"] .thread-actions', { timeout: BUDGET_MS.RENDER }).should('exist');
    cy.get('[role="dialog"] textarea.thread-actions__textarea').type(REPLY_BODY);

    let t0 = 0;
    cy.get('[role="dialog"]')
      .contains('button', 'Send text')
      .click()
      .then(() => {
        t0 = Date.now();
      });
    // The server's verdict, redacted the way the callable redacts it. The
    // second sentence is `mirrorDisclosure(true)`: the mirror row was written.
    cy.get('[role="dialog"]').contains('Reply sent', { timeout: BUDGET_MS.SEND }).should('exist');
    cy.get('[role="dialog"]').contains(`Sent to ${REDACTED}.`).should('exist');
    cy.get('[role="dialog"]').contains('It is listed below as your reply.').should('exist');
    cy.get('[role="dialog"]').contains('Something did not go through').should('not.exist');
    cy.then(() => {
      expect(Date.now() - t0, 'ms from Send text to the server verdict on screen').to.be.lessThan(BUDGET_MS.SEND);
    });

    // Persistence, through a reload: the reply is a row in the channel list,
    // outbound, beside the text it answered.
    cy.reload();
    cy.contains('.inbox__row--card', INBOUND_BODY, { timeout: BUDGET_MS.RENDER }).should('exist');
    cy.contains('.inbox__row--card', REPLY_BODY, { timeout: BUDGET_MS.RENDER })
      .should('have.attr', 'data-channel', 'sms')
      .find('.inbox__pip')
      .contains('sent')
      .should('exist');

    // The send on the books: Communicate's Recent panel reads the
    // `external_messages` record the callable wrote after Twilio accepted.
    cy.visit('/communicate');
    cy.get('.communicate__recent', { timeout: BUDGET_MS.RENDER }).should('exist');
    cy.get('.communicate__recent').contains('[role="tab"]', 'Text').click();
    cy.contains('.communicate__row', `Text · ${REDACTED}`, { timeout: BUDGET_MS.RENDER })
      .find('.communicate__state')
      .should('have.text', 'Sent');
  });
});
