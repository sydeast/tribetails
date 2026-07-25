import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { getBusinessSettings, type BusinessSettings } from '../api/settings';
import { saveBusinessSettings } from '../api/settingsWrite';
import { type Async } from '../lib/async';
import { DenScreenHeading } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { lastSavedLabel } from '../lib/settingsFormat';
import { SectionNav, sectionTabId, sectionPanelId, type SectionNavItem } from './settings/SectionNav';
import {
  TextFieldsSection,
  BookingBehaviorSection,
  MyTribePortalSection,
  BUSINESS_PROFILE_FIELDS,
  WEATHER_AREA_FIELDS,
  PAYMENT_FIELDS,
} from './settings/sections';
import { BrandingSection } from './settings/BrandingSection';
import { CalendarSyncSection } from './settings/CalendarSyncSection';
import { GoogleCalendarSection } from './settings/GoogleCalendarSection';
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
 * Loads `business_settings/business_settings` once via the one-shot
 * `getBusinessSettings` (a direct Firestore `getDoc`, not a callable — see
 * `api/settings.ts`), not a live listener: a sole admin has no concurrent editor
 * to react to. `Notifications` and `Tags` are their own self-loading editors
 * (`NotificationGate`, `TagsEditor`), so they do not depend on this doc and are
 * rendered directly; the other ten sections read this loaded `data`.
 */

type SectionId =
  | 'businessProfile'
  | 'businessHours'
  | 'weather'
  | 'timeOff'
  | 'kinCare'
  | 'booking'
  | 'payments'
  | 'branding'
  | 'mytribe'
  | 'notifications'
  | 'tags'
  | 'calendar'
  | 'googleCalendar';

/** Nav order. Matches the section order the operator saw approved for this screen. */
const SECTIONS: readonly SectionNavItem<SectionId>[] = [
  { id: 'businessProfile', label: 'Business profile' },
  { id: 'businessHours', label: 'Business hours' },
  { id: 'weather', label: 'Weather area' },
  { id: 'timeOff', label: 'Time off' },
  { id: 'kinCare', label: 'KinCare types' },
  { id: 'booking', label: 'Booking behavior' },
  { id: 'payments', label: 'Payments' },
  { id: 'branding', label: 'Branding' },
  { id: 'mytribe', label: 'MyTribe portal' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'tags', label: 'Tags' },
  { id: 'calendar', label: 'Calendar sync' },
  // Task 7.2. Next to Calendar sync because an operator looking for "the Google
  // thing" will look here, and separate from it because they are two features
  // that fail separately: one reads busy time as a service account, the other
  // writes visits as a signed-in Google account.
  { id: 'googleCalendar', label: 'Google Calendar (editable)' },
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
 * Renders one section's body. The two self-loading sub-editors ignore the shell's
 * `settings` (they fetch their own data); the other ten read it through
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
  // Also self-loading, and it has to be: the OAuth connection lives in a
  // document `firestore.rules` denies to every client, so this panel cannot
  // read it from `business_settings` like the others. It asks a callable.
  if (id === 'googleCalendar') return <GoogleCalendarSection />;

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

/** The ten sections that edit the loaded `business_settings` doc. */
function renderDataSection(
  id: SectionId,
  data: BusinessSettings,
  persist: (patch: Partial<BusinessSettings>) => Promise<void>,
  applyServerChange: (patch: Partial<BusinessSettings>) => void,
): ReactNode {
  switch (id) {
    case 'businessProfile':
      return (
        <TextFieldsSection
          title="Business profile"
          subtitle="Who kinfolk and invoices contact."
          data={data}
          fields={BUSINESS_PROFILE_FIELDS}
          onSave={persist}
        />
      );
    case 'businessHours':
      return <BusinessHoursEditor data={data} onSave={persist} />;
    case 'weather':
      return (
        <TextFieldsSection
          title="Weather area"
          subtitle="Coverage area for the Home weather widgets. A city, metro, or ZIP (e.g. &ldquo;Austin, TX&rdquo;), not a street address."
          data={data}
          fields={WEATHER_AREA_FIELDS}
          onSave={persist}
        />
      );
    case 'timeOff':
      return <TimeOffEditor data={data} onSave={persist} />;
    case 'kinCare':
      return <KinCareRatesEditor data={data} onSave={persist} />;
    case 'booking':
      return <BookingBehaviorSection data={data} onSave={persist} />;
    case 'payments':
      return (
        <TextFieldsSection
          title="Payment options"
          subtitle="How kinfolk pay you; each handle prints on every invoice. Leave one blank to hide it."
          data={data}
          fields={PAYMENT_FIELDS}
          onSave={persist}
        />
      );
    case 'branding':
      return <BrandingSection data={data} onSave={persist} onServerChanged={applyServerChange} />;
    case 'mytribe':
      return <MyTribePortalSection data={data} onSave={persist} onServerChanged={applyServerChange} />;
    case 'calendar':
      return <CalendarSyncSection data={data} onSave={persist} />;
    default:
      return null;
  }
}
