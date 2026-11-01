import { onRequest, Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { wrapHttp } from '../lib/wrapHttp';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveShareLink, type ScrubbedSharePayload } from '../lib/resolveShareLink';
import { listPublicComments, type PublicComment } from './sharedKinTaleComments';
import { FULL_CPU } from '../lib/runtimeOptions';
import { readUnlockCookies, unlockSetCookie } from '../lib/shareUnlock';
import { addGuestKinTaleCommentHandler } from '../public/addGuestKinTaleComment';

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
 * `SHARE_LINK_BASE_URL` now points at this SSR page (both the `mytribe_beta`
 * and `kinfolk_portal` hosting targets rewrite `/share/**` here) — the
 * cutover described as a later step elsewhere is done. This file does not
 * touch `getShareLink.ts`'s external behavior.
 */

// #1278. The guest note no longer posts cross-origin to the
// `addGuestKinTaleComment` function URL. It posts to this page's own path
// (`/share/<token>`, `intent=comment`), and this handler runs the same
// `addGuestKinTaleCommentHandler` in-process after checking the share's
// passcode cookie. Same-origin keeps it inside `connect-src 'self'` and
// `form-action 'self'`, and a passcode-protected tale only takes notes from a
// reader who unlocked it.

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

// ── fonts ────────────────────────────────────────────────────────────────────
// #1278. The page used to pull Google Fonts, which the hosting CSP
// (`style-src 'self'`, `font-src 'self'`) refuses, so the unlocked tale fell
// back to a system serif. The portal already self-hosts the same three
// families through @fontsource; `mytribe/web/scripts/copy-share-fonts.mjs`
// copies those woff2 files to stable, unhashed paths under
// `/share-assets/fonts/` at build time, and this block points at them.
export const SHARE_FONT_PATH = '/share-assets/fonts';
const FONT_FACES: Array<{ family: string; slug: string; weight: number }> = [
  { family: 'Young Serif', slug: 'young-serif', weight: 400 },
  { family: 'Bricolage Grotesque', slug: 'bricolage-grotesque', weight: 400 },
  { family: 'Bricolage Grotesque', slug: 'bricolage-grotesque', weight: 500 },
  { family: 'Bricolage Grotesque', slug: 'bricolage-grotesque', weight: 600 },
  { family: 'Bricolage Grotesque', slug: 'bricolage-grotesque', weight: 700 },
  { family: 'DM Mono', slug: 'dm-mono', weight: 400 },
  { family: 'DM Mono', slug: 'dm-mono', weight: 500 },
];
/** Every woff2 file the page references, by file name. The web build copies exactly these. */
export const SHARE_FONT_FILES: string[] = FONT_FACES.flatMap(({ slug, weight }) => [
  `${slug}-latin-${weight}-normal.woff2`,
  `${slug}-latin-ext-${weight}-normal.woff2`,
]);
// Unicode ranges copied from @fontsource's own CSS for the latin and
// latin-ext subsets, so a browser fetches latin-ext only for a name that needs it.
const LATIN_RANGE =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT_RANGE =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';
const FONT_FACE_BLOCK = FONT_FACES.flatMap(({ family, slug, weight }) =>
  (
    [
      ['latin-ext', LATIN_EXT_RANGE],
      ['latin', LATIN_RANGE],
    ] as const
  ).map(
    ([subset, range]) =>
      `  @font-face{font-family:"${family}";font-style:normal;font-display:swap;font-weight:${weight};` +
      `src:url(${SHARE_FONT_PATH}/${slug}-${subset}-${weight}-normal.woff2) format("woff2");unicode-range:${range};}`,
  ),
).join('\n');
// ── shared visual system (verbatim from ui-ideas/mytribe-shared-kintale-2026-05-31.html) ──
const STYLE_BLOCK = `
${FONT_FACE_BLOCK}
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
  .notelist{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:12px;}
  .note{padding:12px 14px;border-radius:12px;background:rgba(255,255,255,.55);border:1px solid rgba(20,40,80,.08);}
  .note.family{background:rgba(120,150,255,.10);}
  .noteby{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin-bottom:4px;}
  .notename{font-weight:600;}
  .notewhen{font-family:var(--mono);font-size:11px;color:var(--navy-muted);}
  .notebody{white-space:pre-wrap;overflow-wrap:anywhere;}
  .noteserror{margin-top:12px;}
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
  [hidden]{display:none!important;}
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
/**
 * One thread row. Every value that reaches the page goes through `escapeHtml`:
 * the name and the body are typed by strangers, and this document is served to
 * anyone holding the link.
 *
 * The date is rendered in UTC on purpose. The server has no idea what timezone
 * the reader is in, and a wrong local time is worse than an explicit one.
 */
function renderComment(c: PublicComment): string {
  const when =
    c.createdAtMs === null
      ? ''
      : `<span class="notewhen">${escapeHtml(new Date(c.createdAtMs).toISOString().slice(0, 10))}</span>`;
  return `        <li class="note${c.fromGuest ? '' : ' family'}">
          <div class="noteby"><span class="notename">${escapeHtml(c.name)}</span>${when}</div>
          <div class="notebody">${escapeHtml(c.body)}</div>
        </li>`;
}
function renderReadyPage(opts: {
  shareId: string;
  taleId: string | null;
  payload: ScrubbedSharePayload;
  allowGuestComments: boolean;
  comments: PublicComment[];
  commentsFailed: boolean;
  /** #1278. A server-side answer to a guest note posted without JavaScript. */
  notice?: { text: string; cls: 'success-msg' | 'error-msg' };
}): string {
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

  // ISSUE #625. `addGuestKinTaleComment` returns 403 when a share has
  // `allowGuestComments` false. This page used to render the form regardless, so a
  // guest on such a share typed a whole note and was refused only on submit. A
  // control that cannot act is not drawn: the same rule `components/Buttons.tsx`
  // enforces on five admin screens. The server check stays exactly as it is, because
  // a hidden form is not a permission.
  // ISSUE #624, operator ruling: guests see the thread. Rendered above the form,
  // so someone who has just posted scrolls back INTO their own note rather than
  // away from it, and a first-time reader meets the existing notes before the
  // invitation to add one.
  //
  // Gated on the same flag as the form. A share that refuses new comments shows
  // no comment surface at all: the alternative, a readable thread with no way to
  // reply, is a shape nobody asked for. Splitting the two is a one-line change if
  // that turns out to be wanted.
  //
  // #1278. When the share takes notes but nobody has written one yet, the
  // section is still drawn, `hidden`, so the guest-comment script can reveal it
  // and add the note just sent without reloading the page.
  const threadBody = opts.commentsFailed
    ? '<div class="inline-error noteserror">These notes could not be loaded just now. Nothing has been lost: refresh the page to try again.</div>'
    : `<ol class="notelist" id="guest-notes-list">
${opts.comments.map(renderComment).join('\n')}
      </ol>`;
  const threadHidden = opts.comments.length === 0 && !opts.commentsFailed ? ' hidden' : '';
  const threadHtml = opts.allowGuestComments
    ? `
    <section class="glass card noteform" id="guest-notes"${threadHidden}>
      <div class="sectlabel">Notes for the Family</div>
      ${threadBody}
    </section>`
    : '';
  const noticeHtml = opts.notice
    ? `<div class="${opts.notice.cls}">${escapeHtml(opts.notice.text)}</div>`
    : '';
  // #1278. `method="post"` to this page's own path, so a browser that never
  // runs the script still cannot put a guest's name, email or note in a URL.
  // The script (served from this function at GUEST_SCRIPT_PATH, never inline:
  // the CSP has no 'unsafe-inline') adds the reCAPTCHA token and posts the same
  // fields with fetch. Per-page values ride on data- attributes, not in code.
  const commentSectionHtml = opts.allowGuestComments
    ? `    <section class="glass card noteform">
      <div class="sectlabel">Leave a Note for the Family</div>
      <h3 class="title">Send a little love back <span class="heart">&#10084;</span></h3>
      <form id="guest-comment-form" method="post" data-recaptcha-site-key="${escapeHtml(RECAPTCHA_SITE_KEY)}">
        <input type="hidden" name="intent" value="comment">
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
          <noscript><div class="error-msg">${escapeHtml(NO_SCRIPT_NOTICE)}</div></noscript>
          <button class="btn grad block" type="submit" id="guest-comment-submit">Send Note</button>
        </div>
      </form>
      <div id="guest-comment-status" role="status" aria-live="polite">${noticeHtml}</div>
    </section>
    <script src="${GUEST_SCRIPT_PATH}" defer></script>`
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

${threadHtml}
${commentSectionHtml}`;

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
          <form method="post">
            <input type="hidden" name="intent" value="unlock">
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

// ── guest-comment script (#1278) ─────────────────────────────────────────
/**
 * Served by this function at `GUEST_SCRIPT_PATH`, never inlined. The hosting
 * CSP is `script-src 'self' ...` with no `'unsafe-inline'` and no nonce, so the
 * inline handler this page used to carry never ran: the form fell through to a
 * plain GET that put the guest's name, email and note in the address bar. A
 * same-origin file is allowed by `'self'` under the hosting CSP AND under the
 * one this function sends, so the page does not depend on how the two combine.
 *
 * Nothing about the share is interpolated here: the site key rides on the
 * form's `data-recaptcha-site-key`, and the post goes to the page's own path.
 */
export const GUEST_SCRIPT_PATH = '/share/_assets/guest-comment.js';
export const GUEST_COMMENT_SCRIPT = `(function () {
  'use strict';
  var form = document.getElementById('guest-comment-form');
  if (!form) return;
  var siteKey = form.getAttribute('data-recaptcha-site-key') || '';
  var statusEl = document.getElementById('guest-comment-status');
  var submitBtn = document.getElementById('guest-comment-submit');
  var recaptchaScript = document.createElement('script');
  recaptchaScript.src = 'https://www.google.com/recaptcha/enterprise.js?render=' + encodeURIComponent(siteKey);
  recaptchaScript.async = true;
  document.head.appendChild(recaptchaScript);
  function showStatus(message, cls) {
    statusEl.textContent = '';
    var box = document.createElement('div');
    if (cls) box.className = cls;
    box.textContent = message;
    statusEl.appendChild(box);
  }
  function fail(message) {
    submitBtn.disabled = false;
    showStatus(message || ${JSON.stringify('Something went wrong. Please try again.')}, 'error-msg');
  }
  // Shows the note just sent in "Notes for the Family" without a reload.
  // textContent only: these are the guest's own words, never markup.
  function addNote(name, body) {
    var list = document.getElementById('guest-notes-list');
    var section = document.getElementById('guest-notes');
    if (!list || !section) return;
    var li = document.createElement('li');
    li.className = 'note';
    var by = document.createElement('div');
    by.className = 'noteby';
    var who = document.createElement('span');
    who.className = 'notename';
    who.textContent = name;
    var when = document.createElement('span');
    when.className = 'notewhen';
    when.textContent = new Date().toISOString().slice(0, 10);
    by.appendChild(who);
    by.appendChild(when);
    var text = document.createElement('div');
    text.className = 'notebody';
    text.textContent = body;
    li.appendChild(by);
    li.appendChild(text);
    list.appendChild(li);
    section.hidden = false;
  }
  function send(token) {
    var data = new URLSearchParams(new FormData(form));
    data.set('recaptchaToken', token);
    var name = String(data.get('guestName') || '').trim();
    var body = String(data.get('body') || '').trim();
    fetch(window.location.pathname, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: data,
      credentials: 'same-origin',
    })
      .then(function (resp) {
        return resp.json().then(
          function (json) { return { ok: resp.ok, data: json }; },
          function () { return { ok: false, data: null }; }
        );
      })
      .then(function (result) {
        if (!result.ok) {
          fail(result.data && result.data.error);
          return;
        }
        submitBtn.disabled = false;
        showStatus(${JSON.stringify('Thanks! Your note was sent.')}, 'success-msg');
        addNote(name, body);
        form.reset();
      })
      .catch(function () { fail(); });
  }
  form.addEventListener('submit', function (evt) {
    evt.preventDefault();
    submitBtn.disabled = true;
    showStatus(${JSON.stringify('Sending…')}, '');
    var g = window.grecaptcha;
    if (!g || !g.enterprise) {
      fail(${JSON.stringify('Still loading, please try again in a moment.')});
      return;
    }
    g.enterprise.ready(function () {
      g.enterprise
        .execute(siteKey, { action: 'guest_comment' })
        .then(send, function () {
          fail(${JSON.stringify("Could not verify you're not a robot. Please try again.")});
        });
    });
  });
})();
`;
/** Shown in place of a working Send button when the browser runs no script. */
const NO_SCRIPT_NOTICE = 'Sending a note needs JavaScript for the robot check. Turn it on and reload this page.';
// ── response headers (#1278) ─────────────────────────────────────────────
/**
 * The policy this function sends on EVERY response, gate and errors included.
 * Behind the `/share/**` rewrite, Hosting's `**` header block replaces a
 * same-named header the function set (seen on the hosting emulator,
 * 2026-11-01: only the hosting CSP and Cache-Control reach the browser), so
 * this one governs the bare function URL and any route where the hosting
 * block does not apply. Every directive is at least as strict as the hosting
 * one, and the page needs nothing either policy refuses: same-origin script,
 * style and fonts, plus Google's reCAPTCHA hosts. `test/getSharedKinTalePage.test.ts` checks the rendered page
 * against this policy AND the one in `mytribe/firebase.json`.
 */
export const SHARE_PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.google.com https://www.gstatic.com https://www.recaptcha.net",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: https://res.cloudinary.com",
  "connect-src 'self' https://www.google.com https://www.recaptcha.net",
  'frame-src https://www.google.com https://www.recaptcha.net',
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
// ── req/res shapes (same MinimalReq/MinimalRes adapter pattern as the
// codebase's other onRequest handlers, e.g. confirmSecureReset.ts) ─────────
export interface MinimalReq {
  method?: string;
  path?: string;
  query?: Record<string, unknown>;
  /** Parsed form or JSON body; the Functions runtime parses urlencoded posts. */
  body?: unknown;
  /** Raw `Cookie` header. Hosting forwards only `__session`. */
  cookie?: string;
  /** Raw `Accept` header: the script asks for JSON, a plain form post does not. */
  accept?: string;
}
export interface MinimalRes {
  status(code: number): MinimalRes;
  set(header: string, value: string): MinimalRes;
  send(body: string): void;
}
function setPageHeaders(res: MinimalRes): void {
  res
    .set('Content-Security-Policy', SHARE_PAGE_CSP)
    // An unlocked page is now served at the SAME URL as the gate, told apart
    // only by the cookie, so no cache may keep a copy.
    .set('Cache-Control', 'private, no-store')
    .set('Vary', 'Cookie')
    .set('Referrer-Policy', 'no-referrer')
    .set('X-Content-Type-Options', 'nosniff');
}
function sendHtml(res: MinimalRes, status: number, html: string): void {
  setPageHeaders(res);
  res.status(status).set('Content-Type', 'text/html; charset=utf-8').send(html);
}
function sendJson(res: MinimalRes, status: number, payload: Record<string, unknown>): void {
  setPageHeaders(res);
  res.status(status).set('Content-Type', 'application/json; charset=utf-8').send(JSON.stringify(payload));
}
function redirect(res: MinimalRes, location: string): void {
  setPageHeaders(res);
  res.status(303).set('Location', location).send('');
}
/**
 * The page's own clean path, as the browser addressed it. Behind the hosting
 * rewrite that is `/share/<id>`; on the bare function URL it is `/<id>`. The
 * unlock cookie is scoped to the same path.
 */
function sharePath(reqPath: string, shareId: string): string {
  const prefix = reqPath.startsWith('/share/') ? '/share/' : '/';
  return `${prefix}${encodeURIComponent(shareId)}`;
}
function field(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}
function hasQuery(query: Record<string, unknown> | undefined): boolean {
  return !!query && Object.keys(query).length > 0;
}
/** Reads the thread for a ready page. A failed read is said out loud, never shown as empty (#624). */
async function loadThread(
  allowGuestComments: boolean,
  taleId: string | null,
): Promise<{ comments: PublicComment[]; commentsFailed: boolean }> {
  if (!allowGuestComments || !taleId) return { comments: [], commentsFailed: false };
  try {
    return { comments: await listPublicComments(taleId), commentsFailed: false };
  } catch {
    return { comments: [], commentsFailed: true };
  }
}
type Resolved = Extract<Awaited<ReturnType<typeof resolveShareLink>>, { ok: true }>;
async function sendReadyPage(
  res: MinimalRes,
  status: number,
  shareId: string,
  result: Resolved,
  notice?: { text: string; cls: 'success-msg' | 'error-msg' },
): Promise<void> {
  const { comments, commentsFailed } = await loadThread(result.allowGuestComments, result.sourceKinTaleId);
  sendHtml(
    res,
    status,
    renderReadyPage({
      shareId,
      taleId: result.sourceKinTaleId,
      payload: result.scrubbedPayload,
      allowGuestComments: result.allowGuestComments,
      comments,
      commentsFailed,
      notice,
    }),
  );
}
function sendResolveFailure(
  res: MinimalRes,
  result: Exclude<Awaited<ReturnType<typeof resolveShareLink>>, { ok: true }>,
  wrongPasscode: boolean,
): void {
  if (result.status === 401) {
    sendHtml(res, 401, renderPasscodeGatePage({ wrongPasscode }));
    return;
  }
  sendHtml(res, result.status, renderTerminalPage(result.status, result.error as 'not-found' | 'revoked' | 'expired'));
}
/**
 * A guest note (#1278). Checks the share (and its passcode cookie) here, then
 * hands the fields to `addGuestKinTaleCommentHandler`, which keeps every rule
 * it already had: revoked/expired/comments-off refusals, reCAPTCHA Enterprise
 * verification, the per-email rate limit and the write to
 * `kin_care_reports/{taleId}/comments`, the collection the page's thread, the
 * portal and the admin apps all read.
 *
 * Only the five named fields are forwarded. `skipRecaptchaForTest` can never
 * arrive from a browser.
 */
async function handleGuestComment(req: MinimalReq, res: MinimalRes, shareId: string): Promise<void> {
  const wantsJson = (req.accept ?? '').includes('application/json');
  const result = await resolveShareLink(shareId, undefined, readUnlockCookies(req.cookie));
  if (!result.ok) {
    if (wantsJson) {
      sendJson(res, result.status, {
        error: result.status === 401 ? 'Unlock this tale with its passcode first.' : 'This share link is no longer available.',
      });
      return;
    }
    sendResolveFailure(res, result, false);
    return;
  }
  const recaptchaToken = field(req.body, 'recaptchaToken');
  if (!recaptchaToken && !wantsJson) {
    // A plain form post: the browser ran no script, so there is no reCAPTCHA
    // token and the note cannot be accepted. Nothing goes in the URL; the page
    // comes back with the reason.
    await sendReadyPage(res, 400, shareId, result, { text: NO_SCRIPT_NOTICE, cls: 'error-msg' });
    return;
  }
  let outStatus = 500;
  let outJson: Record<string, unknown> = { error: 'Something went wrong. Please try again.' };
  await addGuestKinTaleCommentHandler(
    {
      method: 'POST',
      body: {
        shareToken: shareId,
        taleId: result.sourceKinTaleId ?? '',
        guestName: field(req.body, 'guestName') ?? '',
        guestEmail: field(req.body, 'guestEmail') ?? '',
        body: field(req.body, 'body') ?? '',
        ...(recaptchaToken ? { recaptchaToken } : {}),
      },
    },
    {
      status(code: number) {
        outStatus = code;
        return this;
      },
      json(payload: Record<string, unknown>) {
        outJson = payload;
      },
    },
  );
  // The comment handler's 400 carries a zod dump in `detail`; a guest gets the
  // short message only.
  const publicJson =
    outStatus === 200 ? { commentId: outJson.commentId } : { error: String(outJson.error ?? 'Something went wrong.') };
  if (wantsJson) {
    sendJson(res, outStatus, publicJson);
    return;
  }
  if (outStatus === 200) {
    redirect(res, sharePath(req.path ?? '', shareId));
    return;
  }
  await sendReadyPage(res, outStatus, shareId, result, { text: String(publicJson.error), cls: 'error-msg' });
}
/**
 * The passcode, by POST only (#1280). A right passcode sets the unlock cookie
 * and redirects (303) to the clean page; a wrong one re-renders the gate with
 * the error. Either way the passcode was only ever in the request body.
 */
async function handleUnlock(req: MinimalReq, res: MinimalRes, shareId: string): Promise<void> {
  const passcode = field(req.body, 'passcode') ?? '';
  const result = await resolveShareLink(shareId, passcode || undefined);
  if (!result.ok) {
    sendResolveFailure(res, result, passcode.length > 0);
    return;
  }
  const path = sharePath(req.path ?? '', shareId);
  if (result.unlockToken) res.set('Set-Cookie', unlockSetCookie(result.unlockToken, path));
  redirect(res, path);
}
export async function getSharedKinTalePageHandler(req: MinimalReq, res: MinimalRes): Promise<void> {
  const method = req.method ?? 'GET';
  if ((req.path ?? '').endsWith(GUEST_SCRIPT_PATH.slice('/share'.length))) {
    if (method !== 'GET' && method !== 'HEAD') {
      sendHtml(res, 405, renderTerminalPage(404, 'not-found'));
      return;
    }
    res
      .status(200)
      .set('Content-Type', 'application/javascript; charset=utf-8')
      .set('Cache-Control', 'public, max-age=300')
      .set('X-Content-Type-Options', 'nosniff')
      .send(GUEST_COMMENT_SCRIPT);
    return;
  }
  if (method !== 'GET' && method !== 'POST') {
    sendHtml(res, 405, renderTerminalPage(404, 'not-found'));
    return;
  }
  const shareId = parseShareId(req.path ?? '');
  if (!shareId) {
    sendHtml(res, 404, renderTerminalPage(404, 'not-found'));
    return;
  }
  if (method === 'POST') {
    const intent = field(req.body, 'intent');
    if (intent === 'comment') {
      await handleGuestComment(req, res, shareId);
      return;
    }
    await handleUnlock(req, res, shareId);
    return;
  }
  const cleanPath = sharePath(req.path ?? '', shareId);
  if (hasQuery(req.query)) {
    // An old link (`?passcode=`), or the old guest form's GET
    // (`?guestName=&guestEmail=&body=`). Honor a right passcode by setting the
    // cookie, then always send the browser to the clean URL so whatever was in
    // the query leaves the address bar and the next history entry.
    const legacy = req.query?.passcode;
    if (typeof legacy === 'string' && legacy.length > 0) {
      const result = await resolveShareLink(shareId, legacy);
      if (result.ok && result.unlockToken) res.set('Set-Cookie', unlockSetCookie(result.unlockToken, cleanPath));
    }
    redirect(res, cleanPath);
    return;
  }
  const result = await resolveShareLink(shareId, undefined, readUnlockCookies(req.cookie));
  if (!result.ok) {
    sendResolveFailure(res, result, false);
    return;
  }
  await sendReadyPage(res, 200, shareId, result);
}
export const getSharedKinTalePage = onRequest(
  // Public HTML behind the /share/** hosting rewrite, and verifies the
  // passcode with argon2 (136ms of CPU per verify). A shared link can be
  // pasted anywhere, so it needs burst headroom as well as the CPU.
  // #1278: guest notes are verified here too (reCAPTCHA Enterprise, through
  // addGuestKinTaleCommentHandler), so this function's service account needs
  // the same reCAPTCHA access addGuestKinTaleComment's already has.
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
    const header = (name: string): string | undefined => {
      const v = req.headers[name];
      return Array.isArray(v) ? v.join('; ') : v;
    };
    await getSharedKinTalePageHandler(
      {
        method: req.method,
        path: req.path,
        query: req.query as Record<string, unknown>,
        body: req.body,
        cookie: header('cookie'),
        accept: header('accept'),
      },
      adapter,
    );
  }),
);
