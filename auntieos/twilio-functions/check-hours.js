exports.handler = function(context, event, callback) {
  const now = new Date();
  const ct = new Date(now.toLocaleString('en-US',
    { timeZone: 'America/Chicago' }));
  const hour = ct.getHours();
  const day = ct.getDay();
  const isOpen = day >= 1 && day <= 5 && hour >= 8 && hour < 18;
  const response = new Twilio.Response();
  response.setBody(isOpen ? 'yes' : 'no');
  callback(null, response);
};
