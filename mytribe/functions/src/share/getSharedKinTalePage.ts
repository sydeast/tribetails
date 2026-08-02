import { onRequest, Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { wrapHttp } from '../lib/wrapHttp';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveShareLink, type ScrubbedSharePayload } from '../lib/resolveShareLink';
import { FULL_CPU } from '../lib/runtimeOptions';

/**
 * getSharedKinTalePage, public HTTPS endpoint.
 *
 * A server-rendered HTML counterpart to `getShareLink` (which the legacy
 * Compose-for-Web app at kinfolk.tribetails.com/share/{id} already consumes
 * as JSON). Compose-for-Web is client-rendered, so a link pasted into
 * iMessage/Slack/Facebook shows a blank preview card — this handler exists
 * so `mytribe-kinfolk-beta.web.app/share/{id}` (wired via the
 * `mytribe_beta` hosting rewrite) returns real HTML with real
 * `<meta property="og:...">` tags for link-preview crawlers, plus a
 * progressively-enhanced guest-comment form for humans.
 *
 * Unauthenticated + publicly reachable: every interpolated value
 * (authorDisplayName, body, echoed error state) MUST go through
 * `escapeHtml()`. This is hand-rolled string templating, nothing escapes
 * automatically the way it would in React.
 *
 * Does NOT touch `SHARE_LINK_BASE_URL` (still points at the legacy app —
 * that cutover is a later, deliberate step) or `getShareLink.ts`'s
 * external behavior.
 */

// Deployed URL for the existing guest-comment endpoint. Mirrors
// `DEFAULT_SHARE_BASE` in the legacy Kotlin `ShareLinkFetcher.kt`.
const ADD_GUEST_COMMENT_URL = 'https://us-central1-auntieos-ttpc.cloudfunctions.net/addGuestKinTaleComment';

// Must match functions/src/public/addGuestKinTaleComment.ts's RECAPTCHA_SITE_KEY
// exactly. NOTE: this deliberately does NOT match the legacy Compose app's
// script-tag render= key (a pre-existing legacy bug, out of scope here) —
// this page uses ONE consistent key throughout.
const RECAPTCHA_SITE_KEY = '6Leix-ksAAAAAFwAl_Ua0n6ZFyPR8PQCZxc2VRIg';

const DESCRIPTION_MAX_CHARS = 200;

// ── HTML escaping ────────────────────────────────────────────────────────────
export function escapeHtml(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncateForDescription(body: string, max = DESCRIPTION_MAX_CHARS): string {
  const trimmed = body.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
}

/** Escaped plain text with `\n` -> `<br>`. Never treats `body` as trusted HTML. */
function bodyToHtml(body: string): string {
  return escapeHtml(body).replace(/\r\n|\r|\n/g, '<br>');
}

/** Only `https://` photo URLs are safe to emit as an `<img src>` — silently drop the rest. */
function safePhotoUrls(photos: string[] | undefined): string[] {
  if (!photos) return [];
  return photos.filter((url) => typeof url === 'string' && url.startsWith('https://'));
}

// ── shareId parsing ──────────────────────────────────────────────────────────
// Handles both a direct function URL (`/{shareId}`) and the hosting rewrite
// path (`/share/{shareId}`) — take the last non-empty path segment.
export function parseShareId(path: string): string {
  const parts = String(path ?? '').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

// ── shared visual system (verbatim from ui-ideas/mytribe-shared-kintale-2026-05-31.html) ──
const STYLE_BLOCK = `
  :root{
    --cream:#FBFBF9; --navy:#11131F;
    --orange:#DF8431; --pink:#D55C87; --teal:#0A8595;
    --purple:#74538A; --coral:#D5535A;
    --navy-soft:rgba(17,19,31,.78); --navy-muted:rgba(17,19,31,.55);
    --hairline:rgba(17,19,31,.10);
    --glass:rgba(255,255,255,.62); --glass-dim:rgba(255,255,255,.40);
    --glass-border:rgba(255,255,255,.7);
    --serif:"Young Serif",serif; --sans:"Bricolage Grotesque",sans-serif; --mono:"DM Mono",monospace;
    --ease:cubic-bezier(.22,.8,.24,1);
    --shadow-card:0 14px 34px -18px rgba(17,19,31,.30);
    --shadow-lift:0 22px 46px -20px rgba(17,19,31,.36);
    --shadow-warm:0 16px 34px -16px rgba(223,132,49,.55);
    --tribe-grad:linear-gradient(135deg,#df8431,#d55c87,#0a8595);
    --orange-pink:linear-gradient(to bottom right,#df8431,#d55c87);
    --teal-purple:linear-gradient(to bottom right,#0a8595,#74538a);
    --maxw:1140px;
  }
  *{box-sizing:border-box;margin:0;padding:0;}
  html{scroll-behavior:smooth;}
  body{
    font-family:var(--sans);color:var(--navy);min-height:100vh;-webkit-font-smoothing:antialiased;
    background:
      radial-gradient(120vmax 70vmax at 82% -10%, rgba(223,132,49,.20), transparent 55%),
      radial-gradient(110vmax 70vmax at 5% 0%, rgba(213,92,135,.16), transparent 52%),
      radial-gradient(130vmax 80vmax at 50% 118%, rgba(10,133,149,.16), transparent 55%),
      var(--cream);
    overflow-x:hidden;
  }
  .orb{position:fixed;border-radius:50%;filter:blur(60px);opacity:.42;z-index:0;pointer-events:none;
    animation:drift 26s var(--ease) infinite alternate;}
  .orb.a{width:32vmax;height:32vmax;top:-6vmax;right:-4vmax;background:radial-gradient(circle,var(--orange),transparent 64%);}
  .orb.b{width:30vmax;height:30vmax;bottom:-10vmax;left:-8vmax;background:radial-gradient(circle,var(--teal),transparent 64%);animation-delay:-10s;}
  @keyframes drift{to{transform:translate(2vmax,2vmax) scale(1.08);}}

  .glass{background:var(--glass);border:1px solid var(--glass-border);border-radius:22px;
    box-shadow:var(--shadow-card);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);}
  .card{padding:22px;}
  .sectlabel{display:flex;align-items:center;gap:8px;margin:0 2px 12px;font-family:var(--mono);font-size:11px;
    letter-spacing:.14em;text-transform:uppercase;color:var(--navy-muted);}
  h3.title{font-family:var(--serif);font-size:20px;font-weight:400;display:flex;align-items:center;gap:8px;}

  .btn{border:none;cursor:pointer;border-radius:14px;padding:14px 18px;font-family:var(--sans);font-size:14.5px;
    font-weight:700;color:#fff;background:var(--navy);display:inline-flex;align-items:center;justify-content:center;gap:9px;
    box-shadow:var(--shadow-card);transition:.2s var(--ease);text-decoration:none;}
  .btn:hover{transform:translateY(-2px);box-shadow:var(--shadow-lift);}
  .btn.grad{background:var(--tribe-grad);box-shadow:var(--shadow-warm);}
  .btn.block{width:100%;}
  .btn:disabled{opacity:.6;cursor:not-allowed;transform:none;}
  .heart{color:var(--coral);}

  @keyframes rise{from{opacity:0;transform:translateY(16px);}to{opacity:1;transform:translateY(0);}}

  .ghead{text-align:center;padding:30px 24px 6px;position:relative;z-index:1;}
  .ghead .wordmark{font-family:var(--serif);font-size:30px;letter-spacing:-.01em;line-height:1;}
  .ghead .wordmark .grad{background:var(--tribe-grad);-webkit-background-clip:text;background-clip:text;color:transparent;}
  .share{max-width:720px;margin:0 auto;padding:18px 24px 60px;position:relative;z-index:1;}

  .badge{display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:11px;letter-spacing:.16em;
    text-transform:uppercase;color:#fff;background:var(--tribe-grad);padding:7px 16px;border-radius:99px;
    box-shadow:var(--shadow-warm);}
  .badge .dot{width:7px;height:7px;border-radius:50%;background:#fff;}
  .center{text-align:center;}

  .talehero{padding:0;overflow:hidden;animation:rise .6s var(--ease) .08s both;}
  .talehero .banner{padding:24px 26px;color:#fff;background:var(--tribe-grad);position:relative;overflow:hidden;}
  .talehero .banner::after{content:"";position:absolute;inset:0;background:radial-gradient(120% 90% at 88% 0%,rgba(255,255,255,.32),transparent 55%);pointer-events:none;}
  .talehero .banner .kick{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;opacity:.9;position:relative;}
  .talehero .banner h1{font-family:var(--serif);font-size:clamp(26px,4.6vw,36px);line-height:1.07;margin:10px 0 4px;position:relative;}
  .talehero .body{padding:24px 26px 26px;}
  .narrative{font-size:15.5px;line-height:1.62;color:var(--navy-soft);}

  .gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:6px;}
  .gallery .shot{aspect-ratio:1;border-radius:16px;overflow:hidden;border:1px solid var(--glass-border);}
  .gallery .shot img{width:100%;height:100%;object-fit:cover;display:block;}
  @media (max-width:520px){.gallery{grid-template-columns:repeat(2,1fr);}}

  .locked{margin-top:24px;animation:rise .6s var(--ease) .16s both;}
  .locked .lockbox{display:flex;gap:14px;align-items:flex-start;padding:18px 20px;}
  .locked .lockicon{flex:0 0 auto;width:46px;height:46px;border-radius:14px;display:grid;place-items:center;font-size:22px;
    background:rgba(116,83,138,.14);}
  .locked h3{font-family:var(--serif);font-size:17px;font-weight:400;}
  .locked p{font-size:13px;color:var(--navy-muted);margin-top:3px;line-height:1.5;}
  .pwrow{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;}
  .field{flex:1;min-width:160px;}
  .field label{display:block;font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;
    color:var(--navy-muted);margin-bottom:6px;}
  input.inp,textarea.inp{width:100%;font-family:var(--sans);font-size:14.5px;color:var(--navy);
    background:rgba(255,255,255,.7);border:1px solid var(--hairline);border-radius:13px;padding:12px 14px;
    transition:.2s var(--ease);}
  input.inp:focus,textarea.inp:focus{outline:none;border-color:var(--orange);box-shadow:0 0 0 3px rgba(223,132,49,.16);}
  textarea.inp{resize:vertical;min-height:104px;line-height:1.5;}
  .inline-error{margin-top:12px;padding:11px 14px;border-radius:12px;background:rgba(213,83,90,.12);color:var(--coral);
    font-size:13px;font-weight:600;}

  .noteform{margin-top:24px;animation:rise .6s var(--ease) .22s both;}
  .formgrid{display:flex;flex-direction:column;gap:14px;margin-top:4px;}
  .success-msg{display:flex;align-items:center;gap:10px;margin-top:14px;padding:13px 16px;border-radius:14px;
    background:rgba(10,133,149,.12);color:var(--teal);font-size:13.5px;font-weight:600;}
  .error-msg{margin-top:14px;padding:13px 16px;border-radius:14px;background:rgba(213,83,90,.12);color:var(--coral);
    font-size:13.5px;font-weight:600;}

  .errcard{padding:16px 18px;max-width:480px;margin:60px auto;text-align:center;}
  .errcard .et{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--coral);margin-bottom:7px;}
  .errcard p{font-size:13.5px;color:var(--navy-soft);line-height:1.45;}
  .errcard.expired .et{color:var(--purple);}

  .gfoot{font-family:var(--mono);font-size:11px;color:var(--navy-muted);text-align:center;margin-top:38px;line-height:1.6;}
  .gfoot b{background:var(--tribe-grad);-webkit-background-clip:text;background-clip:text;color:transparent;font-weight:500;}
  .gfoot .recap{display:block;margin-top:4px;opacity:.85;}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;}}
`;

const HEADER_HTML = `
  <span class="orb a"></span><span class="orb b"></span>
  <header class="ghead">
    <div class="wordmark">My<span class="grad">Tribe</span></div>
  </header>
`;

const FOOTER_HTML = `
    <p class="gfoot">
      Shared with love.
      <span class="recap">protected by reCAPTCHA</span>
    </p>
`;

function renderDocument(opts: { title: string; metaTags: string; bodyHtml: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(opts.title)}</title>
${opts.metaTags}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Young+Serif&family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${STYLE_BLOCK}</style>
</head>
<body>
${HEADER_HTML}
  <main class="share">
${opts.bodyHtml}
${FOOTER_HTML}
  </main>
</body>
</html>`;
}

function genericMetaTags(): string {
  return [
    '<meta property="og:site_name" content="MyTribe">',
    '<meta property="og:type" content="website">',
    '<meta name="twitter:card" content="summary">',
  ].join('\n');
}

// ── Ready ─────────────────────────────────────────────────────────────────
function renderReadyPage(opts: { shareId: string; taleId: string | null; payload: ScrubbedSharePayload }): string {
  const authorDisplayName = opts.payload.authorDisplayName?.trim() || 'Auntie';
  const body = opts.payload.body ?? '';
  const photos = safePhotoUrls(opts.payload.photos);
  const escapedAuthor = escapeHtml(authorDisplayName);
  const description = escapeHtml(truncateForDescription(body));
  const hasImage = photos.length > 0;

  const metaTags = [
    '<meta property="og:site_name" content="MyTribe">',
    `<meta property="og:title" content="A KinTale from ${escapedAuthor}">`,
    `<meta property="og:description" content="${description}">`,
    '<meta property="og:type" content="article">',
    ...(hasImage
      ? [
          `<meta property="og:image" content="${escapeHtml(photos[0])}">`,
          '<meta name="twitter:card" content="summary_large_image">',
        ]
      : ['<meta name="twitter:card" content="summary">']),
  ].join('\n');

  const galleryHtml = hasImage
    ? `
      <div class="sectlabel" style="margin-top:24px;">Captured Moments</div>
      <div class="gallery">
${photos.map((url) => `        <div class="shot"><img src="${escapeHtml(url)}" loading="lazy" alt=""></div>`).join('\n')}
      </div>`
    : '';

  const bodyHtml = `
    <div class="center" style="margin-bottom:20px;">
      <span class="badge"><span class="dot"></span>Family Share</span>
    </div>

    <article class="glass talehero">
      <div class="banner">
        <div class="kick">KinTale Narrative</div>
        <h1>A KinTale from ${escapedAuthor}</h1>
      </div>
      <div class="body">
        <div class="narrative">${bodyToHtml(body)}</div>
${galleryHtml}
      </div>
    </article>

    <section class="glass card noteform">
      <div class="sectlabel">Leave a Note for the Family</div>
      <h3 class="title">Send a little love back <span class="heart">&#10084;</span></h3>
      <form id="guest-comment-form">
        <div class="formgrid">
          <div class="field">
            <label for="guest-name">Your name</label>
            <input class="inp" id="guest-name" name="guestName" type="text" placeholder="Your name" required maxlength="120">
          </div>
          <div class="field">
            <label for="guest-email">Your email</label>
            <input class="inp" id="guest-email" name="guestEmail" type="email" placeholder="you@example.com" required maxlength="320">
          </div>
          <div class="field">
            <label for="guest-body">Your note</label>
            <textarea class="inp" id="guest-body" name="body" placeholder="Your note" required maxlength="2000"></textarea>
          </div>
          <button class="btn grad block" type="submit" id="guest-comment-submit">Send Note</button>
        </div>
      </form>
      <div id="guest-comment-status" role="status" aria-live="polite"></div>
    </section>

    <script>
    (function () {
      var RECAPTCHA_SITE_KEY = ${JSON.stringify(RECAPTCHA_SITE_KEY)};
      var COMMENT_URL = ${JSON.stringify(ADD_GUEST_COMMENT_URL)};
      var SHARE_TOKEN = ${JSON.stringify(opts.shareId)};
      var TALE_ID = ${JSON.stringify(opts.taleId)};

      var recaptchaScript = document.createElement('script');
      recaptchaScript.src = 'https://www.google.com/recaptcha/enterprise.js?render=' + RECAPTCHA_SITE_KEY;
      recaptchaScript.async = true;
      recaptchaScript.defer = true;
      document.head.appendChild(recaptchaScript);

      var form = document.getElementById('guest-comment-form');
      var statusEl = document.getElementById('guest-comment-status');
      var submitBtn = document.getElementById('guest-comment-submit');
      if (!form) return;

      function showStatus(message, cls) {
        statusEl.textContent = message;
        statusEl.className = cls;
      }

      function submitComment(token) {
        var guestName = document.getElementById('guest-name').value;
        var guestEmail = document.getElementById('guest-email').value;
        var body = document.getElementById('guest-body').value;
        fetch(COMMENT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            shareToken: SHARE_TOKEN,
            taleId: TALE_ID,
            guestName: guestName,
            guestEmail: guestEmail,
            body: body,
            recaptchaToken: token,
          }),
        })
          .then(function (resp) {
            return resp.json().then(function (data) {
              return { ok: resp.ok, data: data };
            });
          })
          .then(function (result) {
            submitBtn.disabled = false;
            if (result.ok) {
              showStatus('Thanks! Your note was sent.', 'success-msg');
              form.reset();
            } else {
              showStatus((result.data && result.data.error) || 'Something went wrong. Please try again.', 'error-msg');
            }
          })
          .catch(function () {
            submitBtn.disabled = false;
            showStatus('Something went wrong. Please try again.', 'error-msg');
          });
      }

      form.addEventListener('submit', function (evt) {
        evt.preventDefault();
        submitBtn.disabled = true;
        showStatus('Sending…', '');
        if (window.grecaptcha && window.grecaptcha.enterprise) {
          window.grecaptcha.enterprise.ready(function () {
            window.grecaptcha.enterprise
              .execute(RECAPTCHA_SITE_KEY, { action: 'guest_comment' })
              .then(submitComment)
              .catch(function () {
                submitBtn.disabled = false;
                showStatus('Could not verify you\\'re not a robot. Please try again.', 'error-msg');
              });
          });
        } else {
          submitBtn.disabled = false;
          showStatus('Still loading, please try again in a moment.', 'error-msg');
        }
      });
    })();
    </script>`;

  return renderDocument({ title: `A KinTale from ${authorDisplayName} — MyTribe`, metaTags, bodyHtml });
}

// ── PasscodeGate ──────────────────────────────────────────────────────────
function renderPasscodeGatePage(opts: { wrongPasscode: boolean }): string {
  const errorHtml = opts.wrongPasscode
    ? '<div class="inline-error">That passcode didn\'t work. Please try again.</div>'
    : '';
  const bodyHtml = `
    <section class="glass card locked">
      <div class="sectlabel">Passcode required</div>
      <div class="lockbox">
        <div class="lockicon">&#128274;</div>
        <div style="flex:1;">
          <h3>This tale is passcode-protected.</h3>
          <p>Enter the passcode the family shared with you to read on.</p>
          ${errorHtml}
          <form method="GET">
            <div class="pwrow">
              <div class="field">
                <label for="pc">Passcode</label>
                <input class="inp" id="pc" name="passcode" type="text" placeholder="Passcode" autocomplete="off" required>
              </div>
              <button class="btn grad" type="submit" style="align-self:flex-end;">Unlock</button>
            </div>
          </form>
        </div>
      </div>
    </section>`;
  return renderDocument({ title: 'Passcode required | MyTribe', metaTags: genericMetaTags(), bodyHtml });
}

// ── NotFound / Expired / Revoked ─────────────────────────────────────────
function renderTerminalPage(status: 404 | 410, error: 'not-found' | 'revoked' | 'expired'): string {
  const copy: Record<string, { title: string; message: string; cls: string }> = {
    'not-found': { title: 'Not found', message: "This share link doesn't exist.", cls: '' },
    revoked: { title: 'Link revoked', message: 'This share link has been revoked.', cls: 'expired' },
    expired: { title: 'Link expired', message: 'This share link has expired.', cls: 'expired' },
  };
  const c = copy[error];
  const bodyHtml = `
    <section class="glass errcard ${c.cls}">
      <div class="et">${escapeHtml(c.title)}</div>
      <p>${escapeHtml(c.message)}</p>
    </section>`;
  return renderDocument({ title: `${c.title} — MyTribe`, metaTags: genericMetaTags(), bodyHtml });
}

// ── req/res shapes (same MinimalReq/MinimalRes adapter pattern as the
// codebase's other onRequest handlers, e.g. confirmSecureReset.ts) ─────────
export interface MinimalReq {
  method?: string;
  path?: string;
  query?: Record<string, unknown>;
}
export interface MinimalRes {
  status(code: number): MinimalRes;
  set(header: string, value: string): MinimalRes;
  send(body: string): void;
}

function sendHtml(res: MinimalRes, status: number, html: string): void {
  res.status(status).set('Content-Type', 'text/html; charset=utf-8').send(html);
}

export async function getSharedKinTalePageHandler(req: MinimalReq, res: MinimalRes): Promise<void> {
  if (req.method !== 'GET') {
    sendHtml(res, 405, renderTerminalPage(404, 'not-found'));
    return;
  }
  const shareId = parseShareId(req.path ?? '');
  if (!shareId) {
    sendHtml(res, 404, renderTerminalPage(404, 'not-found'));
    return;
  }
  const passcodeRaw = req.query?.passcode;
  const passcode = typeof passcodeRaw === 'string' && passcodeRaw.length > 0 ? passcodeRaw : undefined;

  const result = await resolveShareLink(shareId, passcode);
  if (!result.ok) {
    if (result.status === 401) {
      sendHtml(res, 401, renderPasscodeGatePage({ wrongPasscode: !!passcode }));
      return;
    }
    sendHtml(res, result.status, renderTerminalPage(result.status, result.error as 'not-found' | 'revoked' | 'expired'));
    return;
  }

  sendHtml(
    res,
    200,
    renderReadyPage({ shareId, taleId: result.sourceKinTaleId, payload: result.scrubbedPayload }),
  );
}

export const getSharedKinTalePage = onRequest(
  // Public HTML behind the /share/** hosting rewrite, and verifies the
  // passcode with argon2 (136ms of CPU per verify). A shared link can be
  // pasted anywhere, so it needs burst headroom as well as the CPU.
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'], ...FULL_CPU },
  wrapHttp('getSharedKinTalePage', async (req: Request, res: Response) => {
    const adapter: MinimalRes = {
      status(code: number) {
        res.status(code);
        return adapter;
      },
      set(header: string, value: string) {
        res.set(header, value);
        return adapter;
      },
      send(body: string) {
        res.send(body);
      },
    };
    await getSharedKinTalePageHandler(
      { method: req.method, path: req.path, query: req.query as Record<string, unknown> },
      adapter,
    );
  }),
);
