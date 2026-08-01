exports.handler = function(context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'alice' }, 'Please hold while we connect your call.');
  twiml.pause({ length: 30 });
  callback(null, twiml);
};
