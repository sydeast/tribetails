exports.handler = function(context, event, callback) {
    const response = new Twilio.twiml.VoiceResponse();
    const dialStatus = event.DialCallStatus;

    if (dialStatus === 'completed') {
      response.hangup();
      callback(null, response);
      return;
    }

    response.say(
      { voice: 'Polly.Joanna' },
      "Thank you for calling Tribe Tails Pet Care. We're unavailable to take your call right now. " +
      "Please leave your name, number, and a brief message after the tone, and we will get back to you as soon as possible."
    );

    response.record({
      maxLength: 120,
      transcribe: true,
      transcribeCallback: `https://${context.DOMAIN_NAME}/notify-voicemail`,
      transcribeCallbackMethod: 'POST'
    });

    response.say(
      { voice: 'Polly.Joanna' },
      "Thank you for your message. We'll be in touch soon. Have a wonderful day!"
    );

    callback(null, response);
  };
