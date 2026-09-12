import { type ReactNode } from 'react';

/**
 * The glyph beside each entry of the Settings section nav.
 *
 * The mock (`ui-ideas/auntieos-settings-2026-05-27.html`, `.secnav a svg`)
 * draws a 17px stroke icon before every label: 24-unit viewBox, no fill,
 * `currentColor` stroke at 1.8, so the glyph takes the row's text colour and
 * flips to navy with the label when the row is active. No icon package is
 * installed here (see the kit's own Chevron), so the paths sit inline: the
 * four the mock draws for sections the shipped screen has (profile, clock,
 * bell, integrations) are copied from it, the rest are drawn in the same
 * stroke for the sections the operator's regroupings added.
 *
 * Every glyph is `aria-hidden`: the tab's accessible name is its label and
 * nothing else, which is what `getByRole('tab', { name })` and the Cypress
 * `cy.contains('[role="tab"]', label)` both key on.
 */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      className="settings__nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const SECTION_ICONS = {
  businessProfile: (
    <Glyph>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-4 3-6 7-6s7 2 7 6" />
    </Glyph>
  ),
  businessHours: (
    <Glyph>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </Glyph>
  ),
  phoneLine: (
    <Glyph>
      <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
    </Glyph>
  ),
  timeOff: (
    <Glyph>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M3 10h18M8 3v4M16 3v4M9.5 14l5 4M14.5 14l-5 4" />
    </Glyph>
  ),
  kinCare: (
    <Glyph>
      <path d="M12 21c-3 0-5-1.6-5-3.6 0-2 2.2-3.4 5-3.4s5 1.4 5 3.4c0 2-2 3.6-5 3.6z" />
      <circle cx="7" cy="10" r="1.6" />
      <circle cx="17" cy="10" r="1.6" />
      <circle cx="10" cy="6" r="1.6" />
      <circle cx="14" cy="6" r="1.6" />
    </Glyph>
  ),
  bookingRules: (
    <Glyph>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M8 12l3 3 5-6" />
    </Glyph>
  ),
  payments: (
    <Glyph>
      <rect x="2" y="5" width="20" height="14" rx="3" />
      <path d="M2 10h20M6 15h4" />
    </Glyph>
  ),
  mytribe: (
    <Glyph>
      <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />
    </Glyph>
  ),
  notifications: (
    <Glyph>
      <path d="M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6Z" />
    </Glyph>
  ),
  tags: (
    <Glyph>
      <path d="M20 12l-8 8-9-9V4h7l10 8z" />
      <circle cx="7.5" cy="7.5" r="1" />
    </Glyph>
  ),
  integrations: (
    <Glyph>
      <path d="M8 7h8M8 12h8M8 17h5" />
      <rect x="3" y="3" width="18" height="18" rx="3" />
    </Glyph>
  ),
} as const satisfies Record<string, ReactNode>;

export type SectionIconId = keyof typeof SECTION_ICONS;
