import type { ReactNode } from 'react';
import type { Destination } from '../lib/nav';

/**
 * The nav rail's icon set: one inline SVG per destination.
 *
 * The 2026-05-27 mocks put a 17px line icon on every rail entry, and the shipped
 * rail had none, which is most of why the rail read as a wall of text. These
 * are drawn here rather than pulled from an icon package
 * because this admin self-hosts everything it renders: no icon dependency is
 * installed, and nothing on a rail that appears on every screen should reach the
 * network. The idiom is the `PlusGlyph` already repeated across the screens
 * (`FormSchemas.tsx`, `Directory.tsx`, `KinTales.tsx`): a 24-unit viewBox, no
 * fill, `currentColor` stroke, `aria-hidden`.
 *
 * The map is keyed by `Destination`, not by the rail's subset, ON PURPOSE. It is
 * exhaustive, so a destination added to `lib/nav.ts` without an icon fails
 * `tsc`, the same compile-time contract `LIVE_LINKS` gives the routes. The four
 * contextual destinations are never pinned in the rail and so never render one
 * today; they cost four paths and they mean a destination promoted into the rail
 * arrives with its icon already drawn.
 */
const GLYPH_PATHS: Record<Destination, ReactNode> = {
  home: (
    <>
      <path d="M3 11l9-8 9 8" />
      <path d="M5 10v9h14v-9" />
    </>
  ),
  directory: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M16 6a3 3 0 0 1 0 6" />
      <path d="M21 20a5 5 0 0 0-4-5" />
    </>
  ),
  kintales: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </>
  ),
  gallery: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="10" r="1.5" />
      <path d="M4 17l4-4 3 3 4-5 5 6" />
    </>
  ),
  coveragePackages: (
    <>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
    </>
  ),
  schedule: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
    </>
  ),
  bookings: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
      <path d="M9 14l2 2 4-4" />
    </>
  ),
  sessions: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  invoices: (
    <>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M9 8h5M9 12h6M9 16h4" />
    </>
  ),
  communicate: (
    <>
      <path d="M3 11v2a1 1 0 0 0 1 1h2l4 4V6L6 10H4a1 1 0 0 0-1 1z" />
      <path d="M16 8a5 5 0 0 1 0 8" />
    </>
  ),
  // A calendar with a send arrow inside it: a message that has a date on it,
  // which is the one thing separating this from Communicate's speaker.
  marketingBlasts: (
    <>
      <path d="M4 6h16v14H4z" />
      <path d="M4 10h16" />
      <path d="M8 4v3M16 4v3" />
      <path d="M8 15l8-3-3 8-1.6-3.4z" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 13l2-8h12l2 8v6H4z" />
      <path d="M4 13h4l1.5 3h5L16 13h4" />
    </>
  ),
  notifications: (
    <>
      <path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </>
  ),
  activity: (
    <>
      <path d="M3 12h4l3 7 4-14 3 7h4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1" />
    </>
  ),
  trainingDocs: (
    <>
      <path d="M12 3a6 6 0 0 0-3 11v3h6v-3a6 6 0 0 0-3-11z" />
      <path d="M10 20h4" />
    </>
  ),
  templates: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M9 9v11" />
    </>
  ),
  kinTaleTemplates: (
    <>
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="M9 13l2 2 4-4" />
    </>
  ),
  formSchemas: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h4" />
    </>
  ),
  featureFlags: (
    <>
      <rect x="2" y="7" width="20" height="10" rx="5" />
      <circle cx="16" cy="12" r="3" />
    </>
  ),

  // Contextual destinations: reachable by URL, never pinned in the rail.
  mediaGallery: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8" cy="9" r="1.5" />
      <path d="M3 17l5-4 4 3 3-2 6 5" />
    </>
  ),
  accountSettings: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  myNotifications: (
    <>
      <path d="M6 9a6 6 0 0 1 9-5" />
      <path d="M18 11c0 6 2 7 2 7H4s2-1 2-7" />
      <path d="M10 20a2 2 0 0 0 4 0" />
      <circle cx="18" cy="5" r="2.5" />
    </>
  ),
  // An envelope with its flap open: an invite sent and still out there. The
  // household-scoped `householdMembers` below is a person, because that screen
  // is about who is in a home; this one is about the letters.
  invites: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 8l9 6 9-6" />
    </>
  ),
  householdMembers: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20c0-3.5 2.7-5.5 6-5.5" />
      <path d="M18 9v6" />
      <path d="M21 12h-6" />
    </>
  ),
  // A stethoscope: earpieces, tubing, and the bell. Reads as veterinary care
  // without borrowing a shape already spent on another destination.
  vetClinics: (
    <>
      <path d="M6 3v5a4 4 0 0 0 8 0V3" />
      <path d="M4.5 3H6M14 3h1.5" />
      <path d="M10 12v2a4 4 0 0 0 8 0v-1" />
      <circle cx="18" cy="11" r="2" />
    </>
  ),
};

/**
 * The rail icon for one destination. Decorative: the label beside it is the
 * link's accessible name, and an icon that announced itself would read the
 * destination twice. Sized in the stylesheet (`.nav-glyph`, shell.css) as well
 * as on the element, so it holds its 17px whether or not the CSS has landed.
 */
export function NavGlyph({ dest }: { dest: Destination }) {
  return (
    <svg
      className="nav-glyph"
      data-glyph={dest}
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPH_PATHS[dest]}
    </svg>
  );
}
