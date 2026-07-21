/**
 * GET /check-hours
 * Returns "yes" if within business hours (Mon-Fri 08:00-18:00 America/Chicago), else "no".
 * Studio split_hours widget branches on response body.
 * Fail-open policy: Studio's "failed" transition routes to open_hours_greeting.
 */
exports.handler = function (context, event, callback) {
  try {
    const now = new Date();
    const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const hour = ct.getHours();
    const day = ct.getDay();
    const isOpen = day >= 1 && day <= 5 && hour >= 8 && hour < 18;

    const response = new Twilio.Response();
    response.appendHeader('Content-Type', 'text/plain');
    response.setBody(isOpen ? 'yes' : 'no');
    return callback(null, response);
  } catch (err) {
    console.error('check-hours error:', err.message);
    return callback(err);
  }
};
