/**
 * /play-recording  (visibility: Public)
 *
 * Proxies a Twilio recording so Auntie can tap the link in email and hear
 * the voicemail without being prompted to log in to Twilio.
 *
 * Called via GET:
 *   /play-recording?sid=RExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *
 * Env vars required (auto-provided when Twilio credentials checkbox is checked):
 *   ACCOUNT_SID
 *   AUTH_TOKEN
 */

const https = require('https');

exports.handler = function (context, event, callback) {
  const response = new Twilio.Response();
  const recordingSid = (event.sid || '').trim();

  if (!recordingSid || !recordingSid.startsWith('RE')) {
    response.setStatusCode(400);
    response.appendHeader('Content-Type', 'text/html');
    response.setBody('<p style="font-family:sans-serif;padding:20px">Invalid or missing recording ID.</p>');
    return callback(null, response);
  }

  const auth = Buffer.from(`${context.ACCOUNT_SID}:${context.AUTH_TOKEN}`).toString('base64');
  const path = `/2010-04-01/Accounts/${context.ACCOUNT_SID}/Recordings/${recordingSid}.mp3`;

  const options = {
    hostname: 'api.twilio.com',
    path:     path,
    headers:  { Authorization: `Basic ${auth}` },
  };

  https.get(options, (twilioRes) => {
    const chunks = [];
    twilioRes.on('data',  (chunk) => chunks.push(chunk));
    twilioRes.on('error', (err)   => {
      console.error('play-recording fetch error:', err.message);
      response.setStatusCode(500);
      response.appendHeader('Content-Type', 'text/html');
      response.setBody('<p style="font-family:sans-serif;padding:20px">Could not fetch recording.</p>');
      callback(null, response);
    });
    twilioRes.on('end', () => {
      if (twilioRes.statusCode !== 200) {
        response.setStatusCode(twilioRes.statusCode);
        response.appendHeader('Content-Type', 'text/html');
        response.setBody(`<p style="font-family:sans-serif;padding:20px">Recording not found (${twilioRes.statusCode}).</p>`);
        return callback(null, response);
      }

      const mp3Base64 = Buffer.concat(chunks).toString('base64');
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Tribe Tails Voicemail</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0f0f0f;
      color: #e8e8e8;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 32px 20px;
    }
    .logo {
      font-size: 0.7rem;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #9c7d4a;
      margin-bottom: 24px;
    }
    .card {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 12px;
      padding: 24px;
      width: 100%;
      max-width: 440px;
    }
    .label {
      font-size: 0.68rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: #888;
      margin-bottom: 10px;
    }
    audio { width: 100%; border-radius: 8px; }
  </style>
</head>
<body>
  <div class="logo">Tribe Tails Pet Care</div>
  <div class="card">
    <div class="label">Voicemail Recording</div>
    <audio controls autoplay src="data:audio/mpeg;base64,${mp3Base64}"></audio>
  </div>
</body>
</html>`;

      response.setStatusCode(200);
      response.appendHeader('Content-Type', 'text/html');
      response.setBody(html);
      callback(null, response);
    });
  }).on('error', (err) => {
    console.error('play-recording HTTPS error:', err.message);
    response.setStatusCode(500);
    response.appendHeader('Content-Type', 'text/html');
    response.setBody('<p style="font-family:sans-serif;padding:20px">Network error fetching recording.</p>');
    callback(null, response);
  });
};
