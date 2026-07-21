exports.handler = function(context, event, callback) {
  const response = new Twilio.twiml.VoiceResponse();
  const dial = response.dial({
    callerId: context.TWILIO_BUSINESS_NUMBER,
    timeout: 25,
    action: `https://${context.DOMAIN_NAME}/reject-call`,
    method: 'POST'
  });
  dial.number(context.TRIBE_BUSINESS_NUMBER);
  callback(null, response);
};
