/**
 * /screen-ui  (visibility: Public)
 * Serves the mobile HTML page Auntie sees when she taps the incoming call notification.
 * Shows caller number, transcript, and Accept / Reject buttons.
 * Opened in a Chrome Custom Tab or WebView inside the AuntieOS app.
 *
 * Called via GET:
 *   /screen-ui?callSid=CA...&from=%2B15125551234&transcript=Hey%20its%20...
 */

exports.handler = function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Content-Type', 'text/html; charset=utf-8');

  const callSid = event.callSid || '';
  const callerNumber = decodeURIComponent(event.from || 'Unknown');
  const transcript = decodeURIComponent(event.transcript || 'No message recorded.');
  const actionBase = `https://${context.DOMAIN_NAME}/screen-action`;

  const acceptUrl = `${actionBase}?callSid=${encodeURIComponent(callSid)}&action=accept`;
  const rejectUrl = `${actionBase}?callSid=${encodeURIComponent(callSid)}&action=reject`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0" />
  <title>Incoming Call</title>
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
      justify-content: flex-start;
      padding: 32px 20px;
    }
    .logo {
      font-size: 0.75rem;
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
      margin-bottom: 20px;
    }
    .label {
      font-size: 0.68rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: #888;
      margin-bottom: 6px;
    }
    .caller-number {
      font-size: 1.5rem;
      font-weight: 700;
      color: #c8a96e;
      margin-bottom: 20px;
      letter-spacing: 0.03em;
    }
    .transcript {
      font-size: 0.95rem;
      color: #e8e8e8;
      line-height: 1.6;
      background: #242424;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 14px;
    }
    .actions {
      display: flex;
      gap: 14px;
      width: 100%;
      max-width: 440px;
    }
    .btn {
      flex: 1;
      padding: 18px;
      border: none;
      border-radius: 10px;
      font-size: 1rem;
      font-weight: 700;
      cursor: pointer;
      text-align: center;
      text-decoration: none;
      display: block;
      transition: opacity 0.15s;
    }
    .btn:active { opacity: 0.75; }
    .btn-accept {
      background: #4caf7d;
      color: #0f0f0f;
    }
    .btn-reject {
      background: #e05c5c;
      color: #fff;
    }
    #status {
      margin-top: 20px;
      font-size: 0.9rem;
      color: #888;
      text-align: center;
    }
    .spinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid #888;
      border-top-color: #c8a96e;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      vertical-align: middle;
      margin-right: 8px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="logo">Tribe Tails Pet Care</div>
  <div class="card">
    <div class="label">Incoming Call From</div>
    <div class="caller-number">${escapeHtml(callerNumber)}</div>
    <div class="label">They said</div>
    <div class="transcript">&ldquo;${escapeHtml(transcript)}&rdquo;</div>
  </div>
  <div class="actions">
    <button class="btn btn-accept" onclick="takeAction('accept')">Accept</button>
    <button class="btn btn-reject" onclick="takeAction('reject')">Reject</button>
  </div>
  <div id="status"></div>

  <script>
    var accepted = false;
    var rejected = false;

    function takeAction(action) {
      if (accepted || rejected) return;
      if (action === 'accept') accepted = true;
      else rejected = true;

      var status = document.getElementById('status');
      status.innerHTML = '<span class="spinner"></span>' + (action === 'accept' ? 'Connecting your call...' : 'Sending to voicemail...');

      document.querySelectorAll('.btn').forEach(function(b) { b.disabled = true; b.style.opacity = '0.4'; });

      var url = action === 'accept' ? '${acceptUrl}' : '${rejectUrl}';

      fetch(url)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.status === 'ok' || data.status === 'expired') {
            if (action === 'accept' && data.status === 'ok') {
              status.textContent = 'Your phone will ring now.';
            } else if (action === 'reject' || data.status === 'expired') {
              status.textContent = data.message || 'Caller sent to voicemail.';
            }
          } else {
            status.textContent = 'Something went wrong. Please check the Twilio logs.';
          }
        })
        .catch(function() {
          status.textContent = 'Network error. Check your connection.';
        });
    }
  </script>
</body>
</html>`;

  response.setStatusCode(200);
  response.setBody(html);
  return callback(null, response);
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
