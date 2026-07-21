exports.handler = async function(context, event, callback) {
  const callSid = event.callSid || event.CallSid || '';
  const action  = event.action  || event.Action  || '';

  const client = context.getTwilioClient();

  if (action === 'accept') {
    callback(null, 'OK');
    return;
  }

  // Reject — end the conference and offer voicemail via keypress
  try {
    await client.conferences('conf_' + callSid).update({ status: 'completed' });
  } catch (e) {
    // Conference may already be gone — continue
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="https://${context.DOMAIN_NAME}/voicemail-choice" timeout="10">
    <Say>I'm sorry I missed your call. To leave a voicemail, press 4 now. Otherwise, have a wonderful day!</Say>
  </Gather>
  <Say>Have a wonderful day!</Say>
  <Hangup/>
</Response>`;

  try {
    await client.calls(callSid).update({ twiml });
  } catch (e) {
    // Call may have already ended
  }

  callback(null, 'OK');
};
