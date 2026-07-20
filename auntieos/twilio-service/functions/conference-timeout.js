exports.handler = async function(context, event, callback) {
  const callStatus   = event.CallStatus   || '';
  const callSid      = event.CallSid      || '';
  const originalCallSid = event.StatusCallbackEvent ? null : null; // not used here

  // Only act when Auntie did NOT answer — 'completed' means she answered normally.
  const missedStatuses = ['no-answer', 'busy', 'failed', 'canceled'];
  if (!missedStatuses.includes(callStatus)) {
    callback(null, 'OK');
    return;
  }

  // Pull originalCallSid from the To field — Twilio passes it in the outbound call params
  // We stored it as a URL param on /incoming-call-client; recover it from StatusCallback params
  const originalSid = event.originalCallSid || '';

  if (!originalSid) {
    callback(null, 'OK');
    return;
  }

  const client = context.getTwilioClient();

  // End the conference so caller is released from hold
  try {
    await client.conferences('conf_' + originalSid).update({ status: 'completed' });
  } catch (e) {
    // Conference may not exist yet or already ended
  }

  // Offer the caller a chance to press 4 for voicemail right now
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="https://${context.DOMAIN_NAME}/voicemail-choice" timeout="10">
    <Say>I'm sorry I missed your call. To leave a voicemail, press 4 now. Otherwise, have a wonderful day!</Say>
  </Gather>
  <Say>Have a wonderful day!</Say>
  <Hangup/>
</Response>`;

  try {
    await client.calls(originalSid).update({ twiml });
  } catch (e) {
    // Caller may have already hung up
  }

  callback(null, 'OK');
};
