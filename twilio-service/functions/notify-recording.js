/**
 * POST /notify-recording
 * Recording status callback for the add_call_recording widget (dual-channel screened calls).
 * Persists recording metadata + pushes FCM data event so operator UI can surface a play link.
 *
 * Twilio posts: RecordingSid, RecordingUrl, RecordingDuration, RecordingChannels,
 * RecordingStatus (in-progress|completed|failed|absent), CallSid, AccountSid.
 *
 * Fail-loud: any branch error is surfaced in the response body; never silently dropped.
 */
const admin = require('firebase-admin');

exports.handler = async function (context, event, callback) {
  const recordingSid      = event.RecordingSid      || '';
  const recordingUrl      = event.RecordingUrl      || '';
  const recordingStatus   = event.RecordingStatus   || '';
  const recordingDuration = event.RecordingDuration || '';
  const recordingChannels = event.RecordingChannels || '';
  const callSid           = event.CallSid           || '';

  console.log('notify-recording | sid:', recordingSid, '| status:', recordingStatus, '| call:', callSid);

  if (recordingStatus !== 'completed') {
    // Acknowledge non-terminal events without side effects; Twilio will retry on transient failures.
    return callback(null, `IGNORED status=${recordingStatus}`);
  }

  const errors = [];
  const playUrl = recordingSid
    ? `https://${context.DOMAIN_NAME}/play-recording?sid=${recordingSid}`
    : '(recording not available)';

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
          type:              'call_recording',
          callSid:           callSid,
          recordingSid:      recordingSid,
          recordingUrl:      recordingUrl,
          recordingDuration: String(recordingDuration),
          recordingChannels: String(recordingChannels),
          playUrl:           playUrl,
        },
        android: { priority: 'high' },
        token: context.FCM_DEVICE_TOKEN,
      });
    } catch (err) {
      errors.push('FCM error: ' + err.message);
      console.error('FCM error in notify-recording:', err.message);
    }
  }

  // TODO(persistence): write { callSid, recordingSid, playUrl, duration, createdAt } to
  // Firestore `call_recordings/{recordingSid}` once collection schema is approved.

  return callback(null, errors.length === 0 ? 'OK' : 'PARTIAL: ' + errors.join('; '));
};
