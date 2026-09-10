import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { getBusinessSettings, type BusinessSettings } from '../api/settings';
import { saveBusinessSettings } from '../api/settingsWrite';
import { type Async } from '../lib/async';
import { DenScreenHeading } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { lastSavedLabel } from '../lib/settingsFormat';
import { SectionNav, sectionTabId, sectionPanelId, type SectionNavItem } from './settings/SectionNav';
import { BookingBehaviorSection, MyTribePortalSection, PaymentOptionsSection } from './settings/sections';
import { BrandingSection } from './settings/BrandingSection';
import { PhoneLineSection } from './settings/PhoneLineSection';
import { BusinessProfileSection } from './settings/BusinessProfileSection';
import { BookingRulesSection } from './settings/BookingRulesSection';
import { VisitsTrackingSection } from './settings/VisitsTrackingSection';
import { CalendarSection } from './settings/CalendarSection';
import { IntegrationsSection } from './settings/IntegrationsSection';
import { BusinessHoursEditor } from './settings/BusinessHoursEditor';
import { TimeOffEditor } from './settings/TimeOffEditor';
import { KinCareRatesEditor } from './settings/KinCareRatesEditor';
import { NotificationGate } from './NotificationGate';
import { TagsEditor } from './TagsEditor';
import './Settings.css';

/**
 * Admin Settings, as ONE nav-driven screen.
 *
 * This replaces the old split (a read-only `Settings` overview whose "Edit
 * settings" button swapped in a separate `SettingsEdit`, each a single long
 * scroll of ~12 stacked panels). Both were flat scroll pages; the section nav
 * the superseded wasm `SettingsScreen.kt` had was never ported when `src/` took
 * over, so the live admin lost it. This restores it: a left [SectionNav] lists
 * every section, and the right column renders only the selected one, editable
 * in place. There is no separate view/edit mode any more.
 *
 * ONE section stays view-only, and says so on its own panel rather than behind a
 * global banner: the MyTribe Home layout (no drag-reorder editor in this repo
 * yet). Everything else saves for real.
 *
 * Google Calendar sync used to be the second one, on the grounds that syncing
 * needed a Google sign-in this admin lacks. It does not: the free/busy import
 * authenticates as a service account inside the Cloud Function, and its callable
 * was deployed the whole time. It is now a full editor with a Run Sync action
 * and a last-run receipt (`settings/CalendarSyncSection.tsx`).
 *
 * CALENDAR IS ONE SECTION, not two. It shipped as two nav items, `calendar`
 * ("Calendar sync") and `googleCalendar` ("Google Calendar (editable)"), which
 * asked an operator to know the difference between a service account reading
 * busy time and an OAuth grant writing events before they could pick a tab.
 * `settings/CalendarSection.tsx` renders both, sub-headed, under `calendar`; the
 * `googleCalendar` id is retired. NOTHING DEEP-LINKS TO A SECTION: `/settings`
 * takes no parameter, the selected section is React state, and no hash or
 * `scrollIntoView` reads the `settings-panel-*` DOM ids that `SectionNav` mints.
 * So retiring an id costs no URL. If section deep links ever arrive, they will
 * need an alias from the retired id, and this is the note that says so.
 *
 * Loads `business_settings/business_settings` once via the one-shot
 * `getBusinessSettings` (a direct Firestore `getDoc`, not a callable — see
 * `api/settings.ts`), not a live listener: a sole admin has no concurrent editor
 * to react to. `Notifications`, `Tags` and `Integrations` are their own
 * self-loading editors (`NotificationGate`, `TagsEditor`,
 * `IntegrationsSection`), so they do not depend on this doc and are rendered
 * directly; the other ten sections read this loaded `data`.
 */

type SectionId =
  | 'businessProfile'
  | 'businessHours'
  | 'phoneLine'
  | 'timeOff'
  | 'kinCare'
  | 'bookingRules'
  | 'visitsTracking'
  | 'payments'
  | 'mytribe'
  | 'notifications'
  | 'tags'
  | 'calendar'
  | 'integrations';

/** Nav order. Matches the section order the operator saw approved for this screen. */
const SECTIONS: readonly SectionNavItem<SectionId>[] = [
  { id: 'businessProfile', label: 'Business profile' },
  { id: 'businessHours', label: 'Business hours' },
  // ISSUE #397. Directly after Business hours, because the live transfer is
  // gated on them: the first question an operator has after turning it off is
  // when it applies.
  { id: 'phoneLine', label: 'Phone line' },
  { id: 'timeOff', label: 'Time off' },
  { id: 'kinCare', label: 'KinCare types' },
  // ISSUE #519: two sections for the twenty `business_settings` fields the three
  // admin clients decoded and none of them edited. They are two rather than one
  // because they answer different questions: `bookingRules` is what a booking is
  // allowed to be, `visitsTracking` is what happens once you are out on it. The
  // split matches how Android already groups them (Business operations holds the
  // tracking + visit defaults; the booking config had no home at all).
  { id: 'bookingRules', label: 'Booking rules' },
  { id: 'visitsTracking', label: 'Visits and tracking' },
  { id: 'payments', label: 'Payments' },
  { id: 'mytribe', label: 'MyTribe portal' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'tags', label: 'Tags' },
  // Both Google calendar capabilities: the free/busy import (Task 7.1) and the
  // editable OAuth calendars (Task 7.2), sub-headed inside one panel. They are
  // still two features that fail separately, which is why they are still two
  // panels with their own receipts; they are one thing to LOOK for, which is why
  // they are one tab.
  { id: 'calendar', label: 'Calendar' },
  // Last because it is the one section that reports rather than edits: the place
  // an operator goes when something ELSE on this screen stopped working.
  { id: 'integrations', label: 'Integrations' },
];

/** The section the screen opens on. Named (not `SECTIONS[0]`) so it stays a
 *  concrete `SectionId` under `noUncheckedIndexedAccess`, and its nav item is
 *  asserted to exist below. */
const FIRST_SECTION: SectionId = 'businessProfile';

export function Settings() {
  const [settings, setSettings] = useState<Async<BusinessSettings>>({ status: 'loading' });
  const [selected, setSelected] = useState<SectionId>(FIRST_SECTION);
  // Which sections have been opened at least once. A section mounts on its first
  // visit and then stays mounted (hidden when not selected), so an in-progress
  // edit survives a trip to another section instead of being silently reset, and
  // the two self-loading sections (Notifications, Tags) don't fetch until opened.
  const [visited, setVisited] = useState<Set<SectionId>>(() => new Set([FIRST_SECTION]));

  // Hoisted so a failed load can hand AsyncRegion a real retry (the
  // FeatureFlags.tsx / FormSchemas.tsx convention).
  const load = useCallback(() => {
    let live = true;
    setSettings({ status: 'loading' });
    getBusinessSettings()
      .then((data) => live && setSettings({ status: 'ready', data }))
      .catch(
        (err: unknown) =>
          live &&
          setSettings({
            status: 'error',
            message: `Couldn't read business settings: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: load,
          }),
      );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  // Shared write plumbing every section's Save calls with ONLY that section's own
  // fields. Folds the confirmed stamp back onto the local ready-baseline (no
  // re-fetch): the doc IS what was just written, merged onto what was already
  // loaded, so a sibling section's un-saved edits (kept in ITS OWN local state,
  // never re-derived from this baseline after mount) are untouched, and
  // `lastSavedLabel` reflects the save immediately.
  const persist = useCallback(async (patch: Partial<BusinessSettings>) => {
    const stamp = await saveBusinessSettings(patch);
    setSettings((prev) =>
      prev.status === 'ready' ? { status: 'ready', data: { ...prev.data, ...patch, ...stamp } } : prev,
    );
  }, []);

  // The same fold as `persist`, WITHOUT the write. Used by the logo fields,
  // whose value was already stored server-side by `confirmBrandAssetUpload`:
  // sending it back through `persist` would issue a second write of a value the
  // server just wrote, and stamp `updatedBy` from this client over the stamp the
  // callable made. No `updatedAt` fold either, for the same reason: the server
  // owns that stamp on this path.
  const applyServerChange = useCallback((patch: Partial<BusinessSettings>) => {
    setSettings((prev) => (prev.status === 'ready' ? { status: 'ready', data: { ...prev.data, ...patch } } : prev));
  }, []);

  const selectSection = useCallback((id: SectionId) => {
    setSelected(id);
    setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Admin"
        title="Settings"
        accentTail="by section."
        subtitle="Pick a section on the left. Each one edits and saves on its own."
      />

      {settings.status === 'ready' ? (
        <p className="settings__updated">{lastSavedLabel(settings.data.updatedAt, settings.data.updatedBy)}</p>
      ) : null}

      <div className="settings__layout">
        <SectionNav items={SECTIONS} selected={selected} onSelect={selectSection} />

        <div className="settings__panelArea">
          {SECTIONS.map((section) => {
            if (!visited.has(section.id)) return null;
            const active = section.id === selected;
            return (
              <div
                key={section.id}
                role="tabpanel"
                id={sectionPanelId(section.id)}
                aria-labelledby={sectionTabId(section.id)}
                className="settings__panel"
                tabIndex={0}
                hidden={!active}
              >
                {renderSection(section.id, settings, persist, applyServerChange, selectSection)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Renders one section's body. The self-loading sub-editors ignore the shell's
 * `settings` (they fetch their own data); the rest read it through
 * `AsyncRegion`, so a not-yet-loaded doc shows one honest loading/error state
 * inside the panel rather than a fabricated blank.
 */
function renderSection(
  id: SectionId,
  settings: Async<BusinessSettings>,
  persist: (patch: Partial<BusinessSettings>) => Promise<void>,
  applyServerChange: (patch: Partial<BusinessSettings>) => void,
  selectSection: (id: SectionId) => void,
): ReactNode {
  if (id === 'notifications') return <NotificationGate />;
  if (id === 'tags') return <TagsEditor />;
  // Calendar owns its own AsyncRegion rather than being wrapped in the shared
  // one below, because only its free/busy half reads `business_settings`. Its
  // OAuth half asks a callable (the connection document is denied to every
  // client by `firestore.rules`), and must not be taken down by a settings load
  // it does not depend on.
  if (id === 'calendar') return <CalendarSection settings={settings} onSave={persist} />;
  // Self-loading too, and for a stronger reason: no client can read a Cloud
  // Functions secret at all, so this section's whole answer is a callable's.
  // `onOpenSection` is what makes its Google Calendar link real rather than a
  // sentence telling the operator to go and find the section themselves; the
  // server's `ownedBySection: googleCalendar` ids from before the calendar tabs
  // merged resolve to 'calendar' below.
  if (id === 'integrations') {
    return (
      <IntegrationsSection
        onOpenSection={(next) => {
          // Checked against the real nav rather than cast. The id arrives from
          // the server (`ownedBySection`), and selecting one this screen does
          // not have would leave the panel area blank with no nav item lit: a
          // dead button that looks like it worked. The retired 'googleCalendar'
          // id aliases to the merged 'calendar' tab; any other unknown id is
          // ignored, and the row's own copy still names where to go.
          const target = next === 'googleCalendar' ? 'calendar' : next;
          const match = SECTIONS.find((section) => section.id === target);
          if (match) selectSection(match.id);
        }}
      />
    );
  }

  return (
    <AsyncRegion
      state={settings}
      what="business settings"
      isEmpty={() => false}
      loading={<p className="settings__hint">Loading business settings…</p>}
      empty={<p className="settings__hint">No settings found.</p>}
    >
      {(data) => renderDataSection(id, data, persist, applyServerChange)}
    </AsyncRegion>
  );
}

/** The sections that edit the loaded `business_settings` doc and nothing else. */
function renderDataSection(
  id: SectionId,
  data: BusinessSettings,
  persist: (patch: Partial<BusinessSettings>) => Promise<void>,
  applyServerChange: (patch: Partial<BusinessSettings>) => void,
): ReactNode {
  switch (id) {
    // FOUR PANELS, ONE TAB. Weather area was one text box and Booking behavior
    // was two toggles, each behind its own nav entry. Mark 16 of the
    // 2026-08-17 walk: "move this and weather area to related setting pages. it
    // does not need to be its own page with so little fields", and the operator
    // named Business profile as where they go.
    //
    // Booking behavior stays its own PANEL rather than being folded into the
    // fields above, because the two save differently: the profile fields stage
    // a draft behind a Save button, the toggles write on every flip. Merging
    // them into one panel would put a Save button next to controls that have
    // already saved.
    //
    // ISSUE #519 gave the time zone its own panel here, on the reasoning that a
    // validated picker whose wrong value silently makes the phone line answer
    // as open around the clock deserved its own save gate. ISSUE #709
    // overrides that: operator, 2026-09-10 walk mark 36, "Time Zone needs to be
    // in the profile box; not its own block." `BusinessProfileSection` now
    // carries the contact fields AND the time zone picker as one panel with one
    // Save, and `TimeZoneSection.tsx` is deleted.
    //
    // ISSUE #712 moved Branding (the Logo and Branding panels) here from its
    // own nav entry: operator, "Branding should be under the business
    // profile. Again we need to group these better." The separate `branding`
    // nav entry is gone; nothing else pointed at it (grepped the whole admin).
    case 'businessProfile':
      return (
        <>
          <BusinessProfileSection data={data} onSave={persist} />
          <BrandingSection data={data} onSave={persist} onServerChanged={applyServerChange} />
          <BookingBehaviorSection data={data} onSave={persist} />
        </>
      );
    case 'businessHours':
      return <BusinessHoursEditor data={data} onSave={persist} />;
    // ISSUE #397: the press-3 live transfer, on or off.
    case 'phoneLine':
      return <PhoneLineSection data={data} onSave={persist} />;
    case 'timeOff':
      return <TimeOffEditor data={data} onSave={persist} />;
    case 'kinCare':
      return <KinCareRatesEditor data={data} onSave={persist} />;
    case 'bookingRules':
      return <BookingRulesSection data={data} onSave={persist} />;
    case 'visitsTracking':
      return <VisitsTrackingSection data={data} onSave={persist} />;
    // ISSUE #409: a real toggle per method, replacing the three free-text
    // boxes whose only off switch was deleting the handle. Operator, walk
    // mark 17: "make it a true toggle for different payment option".
    case 'payments':
      return <PaymentOptionsSection data={data} onSave={persist} />;
    case 'mytribe':
      return <MyTribePortalSection data={data} onSave={persist} onServerChanged={applyServerChange} />;
    default:
      return null;
  }
}
