/**
 * POST /notify-voicemail
 * Transcription callback target for record_voicemail_business and
 * record_voicemail_after_hours widgets.
 * 1. FCM data push to operator (channel: tribe_tails_calls).
 * 2. SendGrid email with transcript + signed play URL.
 *
 * Returns "PARTIAL: ..." with error summary if any channel fails — fail-loud, no silent drop.
 * Migrated from twilio-functions/notify-voicemail.js (2026-05-16).
 */
const admin  = require('firebase-admin');
const sgMail = require('@sendgrid/mail');

exports.handler = async function (context, event, callback) {
  const transcript          = event.TranscriptionText   || 'Transcript not available';
  const transcriptionStatus = event.TranscriptionStatus || '';
  const recordingSid        = event.RecordingSid        || '';
  const callerNumber        = event.From || event.CallerNumber || event.Caller || 'Unknown';

  const playUrl = recordingSid
    ? `https://${context.DOMAIN_NAME}/play-recording?sid=${recordingSid}`
    : '(recording not available)';

  const errors = [];

  if (!context.FCM_DEVICE_TOKEN) {
    errors.push('FCM_DEVICE_TOKEN not set');
  } else {
    try {
      if (!admin.apps.length) {
        const serviceAccount = JSON.parse(
          Runtime.getAssets()['/auntieos-ttpc-firebase-adminsdk-fbsvc-7afc8dd201.json'].open()
        );
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      }

      await admin.messaging().send({
        data: {
          type:                'voicemail',
          callerNumber:        callerNumber,
          transcriptionText:   transcript,
          transcriptionStatus: transcriptionStatus,
          recordingSid:        recordingSid,
          playUrl:             playUrl,
        },
        android: {
          priority: 'high',
          notification: {
            channelId:             'tribe_tails_calls',
            priority:              'high',
            defaultSound:          true,
            defaultVibrateTimings: true,
          },
        },
        token: context.FCM_DEVICE_TOKEN,
      });
    } catch (err) {
      errors.push('FCM error: ' + err.message);
      console.error('FCM error in notify-voicemail:', err.message);
    }
  }

  if (!context.SENDGRID_API_KEY || !context.MY_EMAIL || !context.SENDGRID_FROM_EMAIL) {
    errors.push('SendGrid env vars missing');
  } else {
    try {
      sgMail.setApiKey(context.SENDGRID_API_KEY);
      await sgMail.send({
        to:      context.MY_EMAIL,
        from:    context.SENDGRID_FROM_EMAIL,
        subject: `New Tribe Tails Voicemail from ${callerNumber}`,
        text: [
          `New voicemail received.`,
          ``,
          `From: ${callerNumber}`,
          ``,
          `Transcript:`,
          transcript,
          ``,
          `Recording (tap or click to listen):`,
          playUrl,
        ].join('\n'),
      });
    } catch (err) {
      errors.push('SendGrid error: ' + err.message);
      console.error('SendGrid error in notify-voicemail:', err.message);
    }
  }

  return callback(null, errors.length === 0 ? 'OK' : 'PARTIAL: ' + errors.join('; '));
};
