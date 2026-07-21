/**
 * POST /screen-notify
 * Fires after gather_intro captures caller's stated reason.
 * 1. Outbound dial to client:auntie (Voice SDK identity); caller stays on hold in Studio.
 * 2. FCM data push to operator device with transcript + callSid.
 *
 * Migrated from twilio-functions/screen-notify.js (2026-05-16). Behavior preserved.
 */
const admin = require('firebase-admin');

exports.handler = async function (context, event, callback) {
  const callSid      = event.callSid      || event.CallSid || '';
  const transcript   = event.transcript   || event.SpeechResult || 'Caller did not state a reason';
  const callerNumber = event.callerNumber || event.From || event.Caller || 'Unknown';
  const client = context.getTwilioClient();

  console.log('screen-notify | callSid:', callSid, '| caller:', callerNumber);

  try {
    const toIdentity = `client:${context.CLIENT_IDENTITY || 'auntie'}`;
    await client.calls.create({
      to:   toIdentity,
      from: context.TWILIO_BUSINESS_NUMBER,
      url:  `https://${context.DOMAIN_NAME}/incoming-call-client?originalCallSid=${callSid}&callerNumber=${encodeURIComponent(callerNumber)}&transcript=${encodeURIComponent(transcript)}`,
      statusCallback:      `https://${context.DOMAIN_NAME}/conference-timeout?originalCallSid=${callSid}`,
      statusCallbackEvent: ['no-answer', 'busy', 'failed', 'canceled', 'completed'],
      timeout: 55,
    });

    if (!admin.apps.length) {
      const serviceAccount = JSON.parse(
        Runtime.getAssets()['/auntieos-ttpc-firebase-adminsdk-fbsvc-7afc8dd201.json'].open()
      );
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }

    await admin.messaging().send({
      data: {
        type:         'call_invite',
        callSid:      callSid,
        callerNumber: callerNumber,
        transcript:   transcript,
      },
      android: { priority: 'high' },
      token: context.FCM_DEVICE_TOKEN,
    });

    return callback(null, 'OK');
  } catch (err) {
    console.error('screen-notify FAILED:', err.message, err.stack);
    return callback(err);
  }
};
