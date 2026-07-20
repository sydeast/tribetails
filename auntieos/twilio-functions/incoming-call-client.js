exports.handler = async function(context, event, callback) {
  const originalCallSid = event.originalCallSid || '';
  const conferenceName  = `conf_${originalCallSid}`;
  const client = context.getTwilioClient();

  if (originalCallSid) {
    // Pull the caller out of Studio's hold music and into the conference.
    // The caller has startConferenceOnEnter=false so they wait for Auntie to join.
    try {
      await client.calls(originalCallSid).update({
        twiml: `<Response><Dial><Conference startConferenceOnEnter="false" endConferenceOnExit="true" beep="false">${conferenceName}</Conference></Dial></Response>`
      });
      console.log('Caller redirected to conference:', conferenceName);
    } catch (e) {
      console.error('Could not redirect caller to conference:', e.message);
    }
  }

  // Auntie joins the conference with startConferenceOnEnter=true — this starts it.
  const twiml = new Twilio.twiml.VoiceResponse();
  if (originalCallSid) {
    const dial = twiml.dial();
    dial.conference(conferenceName, {
      startConferenceOnEnter: true,
      endConferenceOnExit: true,
      beep: false,
    });
  } else {
    twiml.say('Unable to connect. Please try your call again.');
    twiml.hangup();
  }

  callback(null, twiml);
};
