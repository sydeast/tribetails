import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { getBusinessSettings, type BusinessSettings } from '../api/settings';
import { saveBusinessSettings } from '../api/settingsWrite';
import { type Async } from '../lib/async';
import { DenScreenHeading } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { lastSavedLabel } from '../lib/settingsFormat';
import { SectionNav, sectionTabId, sectionPanelId, type SectionNavItem } from './settings/SectionNav';
import { SECTION_ICONS } from './settings/sectionIcons';
import { BookingBehaviorSection, MyTribePortalSection, PaymentOptionsSection } from './settings/sections';
import { BrandingSection } from './settings/BrandingSection';
import { PhoneLineSection } from './settings/PhoneLineSection';
import { BusinessProfileSection } from './settings/BusinessProfileSection';
import { BookingRulesSection } from './settings/BookingRulesSection';
import { VisitsTrackingSection } from './settings/VisitsTrackingSection';
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
 * CALENDAR LIVES INSIDE INTEGRATIONS, not as its own nav entry. It was already
 * one section holding both Google Calendar capabilities (the free/busy import
 * and the editable OAuth calendars, sub-headed, since the 2026-07-31 tab
 * merge); ISSUE #715 moved that whole section under `integrations` instead of
 * keeping it a sibling tab, on the operator's own words: "And Calendar needs
 * to go under integrations." `IntegrationsSection` now owns rendering
 * `CalendarSection` inline, below its Google Calendar row, when that row's
 * toggle is opened; see the comment on `IntegrationsSection` for how. The
 * `calendar` `SectionId` and its nav entry are gone.
 *
 * NOTHING DEEP-LINKS TO A SECTION BY DEFAULT: the selected section is React
 * state, and no hash or `scrollIntoView` reads the `settings-panel-*` DOM ids
 * that `SectionNav` mints, so retiring most ids costs no URL. The one
 * exception is `?section=<id>` (`routes/SettingsView.tsx`), added for #718 so
 * the retired `/notification-gate` route has somewhere real to land; a
 * section id that redirect ever targets needs an alias from its old id if it
 * is retired later. Grepped the whole admin for the four ids these
 * regrouping issues retired (`timeZone` was never a `SectionId` at all: it
 * was a field inside the `businessProfile` panel from the start; `branding`,
 * `visitsTracking` and `calendar` were): nothing outside this file read any
 * of them as a nav id. The one real caller that named a retired id is
 * server-side: `getIntegrationsHealth`'s `ownedBySection`, which can still
 * say the retired `googleCalendar` from an older deploy, or the current
 * `calendar`, and it is handled without an alias table: `IntegrationsSection`
 * treats ANY non-empty `ownedBySection` as "this row expands inline," never
 * comparing against a specific string, so either value works. If a future
 * section needs an actual URL deep link beyond `?section=`, it will need to
 * invent one; there is currently nothing else to alias.
 *
 * Loads `business_settings/business_settings` once via the one-shot
 * `getBusinessSettings` (a direct Firestore `getDoc`, not a callable — see
 * `api/settings.ts`), not a live listener: a sole admin has no concurrent editor
 * to react to. `Notifications` and `Tags` are their own self-loading editors
 * (`NotificationGate`, `TagsEditor`), so they do not depend on this doc and are
 * rendered directly. `Integrations` is self-loading too (a Cloud Functions
 * secret answer no client can read), but it now also receives the loaded
 * `settings` and the shared `persist`, purely to hand them to the Calendar
 * panels it can open inline. The other nine sections read this loaded `data`.
 */

type SectionId =
  | 'businessProfile'
  | 'businessHours'
  | 'phoneLine'
  | 'timeOff'
  | 'kinCare'
  | 'bookingRules'
  | 'payments'
  | 'mytribe'
  | 'notifications'
  | 'tags'
  | 'integrations';

/**
 * Nav order. Matches the section order the operator saw approved for this
 * screen. Each entry carries the mock's glyph (`settings/sectionIcons.tsx`).
 */
const SECTIONS: readonly SectionNavItem<SectionId>[] = [
  { id: 'businessProfile', label: 'Business profile', icon: SECTION_ICONS.businessProfile },
  { id: 'businessHours', label: 'Business hours', icon: SECTION_ICONS.businessHours },
  // ISSUE #397. Directly after Business hours, because the live transfer is
  // gated on them: the first question an operator has after turning it off is
  // when it applies.
  { id: 'phoneLine', label: 'Phone line', icon: SECTION_ICONS.phoneLine },
  { id: 'timeOff', label: 'Time off', icon: SECTION_ICONS.timeOff },
  // ISSUE #711: "There are settings all over the place and are not grouped by
  // topic very well. 'Visits & Tracking' is Just KinCare settings. So put it
  // under the KinCare 'Types' which needs to be changed to KinCare Settings."
  // ISSUE #519 had split the twenty `business_settings` fields the three admin
  // clients decoded and none of them edited into two sections on the
  // reasoning that they answered different questions: `bookingRules` is what
  // a booking is ALLOWED to be, the visit-day fields are what happens once you
  // are out on it. That second question is a KinCare question, per the
  // operator's ruling above, so its answer moved in with the KinCare types
  // editor rather than staying its own tab. `bookingRules` is unaffected: it
  // still answers the first question, on its own.
  { id: 'kinCare', label: 'KinCare Settings', icon: SECTION_ICONS.kinCare },
  { id: 'bookingRules', label: 'Booking rules', icon: SECTION_ICONS.bookingRules },
  { id: 'payments', label: 'Payments', icon: SECTION_ICONS.payments },
  { id: 'mytribe', label: 'MyTribe portal', icon: SECTION_ICONS.mytribe },
  { id: 'notifications', label: 'Notifications', icon: SECTION_ICONS.notifications },
  { id: 'tags', label: 'Tags', icon: SECTION_ICONS.tags },
  // Last because it is the one section that reports rather than edits: the
  // place an operator goes when something ELSE on this screen stopped
  // working. ISSUE #715 folded the Calendar tab in here too (the free/busy
  // import and the editable OAuth calendars, sub-headed inside one panel,
  // opened in place from the Google Calendar row below): "And Calendar needs
  // to go under integrations."
  { id: 'integrations', label: 'Integrations', icon: SECTION_ICONS.integrations },
];

/** The section the screen opens on. Named (not `SECTIONS[0]`) so it stays a
 *  concrete `SectionId` under `noUncheckedIndexedAccess`, and its nav item is
 *  asserted to exist below. */
const FIRST_SECTION: SectionId = 'businessProfile';

interface SettingsProps {
  /**
   * Seeds which section opens first, from `routes/SettingsView.tsx`'s
   * `?section=` search param. The only caller today is the `/notification-gate`
   * redirect (#718); an absent or unrecognized value opens `FIRST_SECTION`,
   * exactly like a plain visit to `/settings` always has.
   */
  initialSection?: string;
}

export function Settings({ initialSection }: SettingsProps = {}) {
  const startSection: SectionId =
    initialSection !== undefined && SECTIONS.some((s) => s.id === initialSection)
      ? (initialSection as SectionId)
      : FIRST_SECTION;

  const [settings, setSettings] = useState<Async<BusinessSettings>>({ status: 'loading' });
  const [selected, setSelected] = useState<SectionId>(startSection);
  // Which sections have been opened at least once. A section mounts on its first
  // visit and then stays mounted (hidden when not selected), so an in-progress
  // edit survives a trip to another section instead of being silently reset, and
  // the two self-loading sections (Notifications, Tags) don't fetch until opened.
  const [visited, setVisited] = useState<Set<SectionId>>(() => new Set([startSection]));

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
      {/* The mock's `.head`: kicker "The Den · Settings", title "How the Den
          runs". The explanation is the heading's tooltip; the last-saved stamp
          is a value, so it sits on `detail` once the doc is in. */}
      <DenScreenHeading
        kicker="The Den · Settings"
        title="How the Den"
        accentTail="runs."
        subtitle="Pick a section on the left. Each one edits and saves on its own."
        detail={
          settings.status === 'ready'
            ? lastSavedLabel(settings.data.updatedAt, settings.data.updatedBy)
            : undefined
        }
      />

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
                {renderSection(section.id, settings, persist, applyServerChange)}
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
): ReactNode {
  if (id === 'notifications') return <NotificationGate />;
  if (id === 'tags') return <TagsEditor />;
  // Self-loading, and for a stronger reason than Notifications/Tags: no
  // client can read a Cloud Functions secret at all, so this section's whole
  // answer is a callable's. It also receives `settings` and `persist`
  // (unused by the health check itself) purely so it can open the Calendar
  // panels inline below its Google Calendar row; see the comment on
  // `IntegrationsSection` for the full reasoning (issue #715).
  if (id === 'integrations') {
    return <IntegrationsSection settings={settings} onSaveCalendar={persist} />;
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
    // FOUR PANELS, ONE TAB. Weather area was one text box and the booking
    // toggles were two switches, each behind its own nav entry. Mark 16 of the
    // 2026-08-17 walk: "move this and weather area to related setting pages. it
    // does not need to be its own page with so little fields", and the operator
    // named Business profile as where they go.
    //
    // The toggles stay their own PANEL (titled "Scheduling", the mock's word,
    // since the #755 pass) rather than being folded into the fields above,
    // because the two save differently: the profile fields stage a draft
    // behind a Save button, the toggles write on every flip. Merging them into
    // one panel would put a Save button next to controls that have already
    // saved.
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
    // ISSUE #711: KinCare Settings holds both the types/rates editor and the
    // visit-day tracking settings now, each its own DenPanel (so each keeps
    // its own heading, the `KinCareRatesEditor` title and the
    // `VisitsTrackingSection` title) under the one renamed nav entry.
    case 'kinCare':
      return (
        <>
          <KinCareRatesEditor data={data} onSave={persist} />
          <VisitsTrackingSection data={data} onSave={persist} />
        </>
      );
    case 'bookingRules':
      return <BookingRulesSection data={data} onSave={persist} />;
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
