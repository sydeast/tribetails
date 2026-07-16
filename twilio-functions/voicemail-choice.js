exports.handler = function(context, event, callback) {
  const digits = event.Digits || '';
  const twimlResponse = require('twilio').twiml;
  const response = new twimlResponse.VoiceResponse();

  if (digits === '4') {
    response.say(
      'Please leave your message after the beep and press pound when finished.'
    );
    response.record({
      maxLength: 180,
      playBeep: true,
      finishOnKey: '#',
      transcribe: true,
      transcriptionCallback: `https://${context.DOMAIN_NAME}/notify-voicemail`
    });
    response.say('Thank you for your message. Have a wonderful day!');
  } else {
    response.say('Have a wonderful day!');
  }

  response.hangup();
  callback(null, response);
};
