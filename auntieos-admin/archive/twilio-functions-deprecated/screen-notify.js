const admin = require('firebase-admin');

exports.handler = async function(context, event, callback) {
  const callSid      = event.callSid      || event.CallSid || '';
  const transcript   = event.transcript   || event.SpeechResult || 'Caller did not state a reason';
  const callerNumber = event.callerNumber || event.From || event.Caller || 'Unknown';
  const client = context.getTwilioClient();

  console.log('screen-notify fired | callSid:', callSid, '| caller:', callerNumber);
  console.log('CLIENT_IDENTITY:', context.CLIENT_IDENTITY);
  console.log('TWILIO_BUSINESS_NUMBER:', context.TWILIO_BUSINESS_NUMBER);

  try {
    // 1. Create outbound Voice SDK call to client:auntie.
    // The caller stays in Studio's hold_play (hold music).
    // incoming-call-client will bridge both into a conference when Auntie answers.
    const toIdentity = `client:auntie`;
    console.log('Step 1: calling', toIdentity, 'from', context.TWILIO_BUSINESS_NUMBER);
    await client.calls.create({
      to:   toIdentity,
      from: context.TWILIO_BUSINESS_NUMBER,
      url:  `https://${context.DOMAIN_NAME}/incoming-call-client?originalCallSid=${callSid}&callerNumber=${encodeURIComponent(callerNumber)}&transcript=${encodeURIComponent(transcript)}`,
      statusCallback:      `https://${context.DOMAIN_NAME}/conference-timeout?originalCallSid=${callSid}`,
      statusCallbackEvent: ['no-answer', 'busy', 'failed', 'canceled', 'completed'],
      timeout: 55,
    });
    console.log('Step 1 complete');

    // 2. FCM data message
    console.log('Step 2: sending FCM...');
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
    console.log('Step 2 complete');

    callback(null, 'OK');
  } catch (err) {
    console.error('screen-notify FAILED:', err.message);
    console.error('Stack:', err.stack);
    callback(err);
  }
};
