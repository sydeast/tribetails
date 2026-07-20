exports.handler = function(context, event, callback) {
  const AccessToken = Twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: context.TWIML_APP_SID,
    incomingAllow: true,
    pushCredentialSid: context.PUSH_CREDENTIAL_SID,
  });

  const token = new AccessToken(
    context.ACCOUNT_SID,
    context.TWILIO_API_KEY_SID,
    context.TWILIO_API_KEY_SECRET,
    { identity: context.CLIENT_IDENTITY, ttl: 3600 }
  );

  token.addGrant(voiceGrant);
  callback(null, { token: token.toJwt() });
};
