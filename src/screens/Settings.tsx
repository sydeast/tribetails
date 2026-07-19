import { useCallback, useEffect, useState } from 'react';
import { getBusinessSettings, type BusinessSettings } from '../api/settings';
import { type Async } from '../lib/async';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { PrimaryButton } from '../components/Buttons';
import { SettingsEdit } from './SettingsEdit';
import { NotificationGate } from './NotificationGate';
import { TagsEditor } from './TagsEditor';
import {
  businessHoursRows,
  serviceRateRows,
  paymentRows,
  observedHolidayLabels,
  companyHolidayRows,
  specialHourRows,
  boolLabel,
  brandingRows,
  portalBannerSummary,
  portalChatSummary,
  portalHomeSummary,
  lastSavedLabel,
} from '../lib/settingsFormat';
import './Settings.css';

interface SettingsProps {
  /**
   * Optional external hook, called (in addition to opening the editor below)
   * whenever the operator clicks "Edit settings". `router.tsx` mounts this
   * screen as a bare route component (`component: Settings`, no props), so
   * nothing wires this today; it exists purely for a future caller (analytics,
   * a route-level breadcrumb) that wants to observe the click. The editor
   * itself does NOT depend on it: see the `editing` state below.
   */
  onEdit?: () => void;
}

/**
 * Admin Settings. Defaults to the READ-ONLY overview: the current
 * `business_settings` document, grouped by the same sections the wasm
 * `SettingsScreen.kt` editor uses. Clicking "Edit settings" switches this
 * screen to `SettingsEdit` (the write surface, `./SettingsEdit.tsx`), in place,
 * with no router change: `router.tsx` mounts `Settings` as a bare route
 * component with no props, so the only way "Edit settings" can open a real
 * editor without touching `router.tsx` is for this screen to own that toggle
 * itself, rather than wait for a parent to hand it one. That is what `editing`
 * below does. Returning from the editor (`onDone`) flips back to the overview
 * and reloads it, so a just-saved change is reflected immediately rather than
 * showing the pre-edit snapshot.
 *
 * Several sections (Business hours, Time off, KinCare types, Google Calendar
 * sync, MyTribe portal Home layout) have no editor yet; see `SettingsEdit.tsx`'s
 * header for exactly which and why. They stay exactly this read-only here.
 *
 * Loads once via the one-shot `getBusinessSettings` (a direct Firestore
 * `getDoc`, not a callable, see `api/settings.ts`'s header for why), not a
 * live listener: an overview does not need to react to a concurrent editor's
 * writes, since there is no concurrent editor session (sole admin).
 */
export function Settings({ onEdit }: SettingsProps) {
  const [settings, setSettings] = useState<Async<BusinessSettings>>({ status: 'loading' });
  // In-place views on this one route (no router change), the same swap pattern
  // "Edit settings" already uses: 'overview' | 'edit' (SettingsEdit) | 'gate'
  // (the business notification gate matrix) | 'tags' (the tag vocabularies).
  const [mode, setMode] = useState<'overview' | 'edit' | 'gate' | 'tags'>('overview');

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

  if (mode === 'edit') {
    return (
      <SettingsEdit
        onDone={() => {
          setMode('overview');
          load();
        }}
      />
    );
  }

  if (mode === 'gate') {
    return <NotificationGate onBack={() => setMode('overview')} />;
  }

  if (mode === 'tags') {
    return <TagsEditor onBack={() => setMode('overview')} />;
  }

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Admin"
        title="Settings"
        accentTail="overview."
        subtitle="What's currently saved on your business settings, grouped by section."
        trailing={
          <PrimaryButton
            label="Edit settings"
            onClick={() => {
              onEdit?.();
              setMode('edit');
            }}
          />
        }
      />

      <Banner tone="info" dashed pillLabel="Read-only">
        This is an overview, not the editor. Values below are exactly what&rsquo;s saved; click
        &ldquo;Edit settings&rdquo; above to change them.
      </Banner>

      <DenPanel
        title="Notifications"
        subtitle="Audience tabs (Business, Staff, Kinfolk) and the per-channel gate for every notification."
      >
        <p className="settings__hint">
          Set which channels each notification can use, and lock any that must stay on. This is the gate
          that everyone&rsquo;s own notification choices sit inside.
        </p>
        <PrimaryButton label="Open notification gate" onClick={() => setMode('gate')} />
      </DenPanel>

      <DenPanel
        title="Tags"
        subtitle="The labels you put on households and pets, each with its own color and emoji."
      >
        <p className="settings__hint">
          Build the two tag lists (household and pet) that show up as suggestions when you tag a
          profile, and that broadcasts and KinTale rules match on.
        </p>
        <PrimaryButton label="Open tags" onClick={() => setMode('tags')} />
      </DenPanel>

      <AsyncRegion
        state={settings}
        what="business settings"
        isEmpty={() => false}
        loading={<p className="settings__hint">Loading business settings…</p>}
        empty={<p className="settings__hint">No settings found.</p>}
      >
        {(data) => (
          <>
            <p className="settings__updated">{lastSavedLabel(data.updatedAt, data.updatedBy)}</p>

            <DenPanel title="Business profile" subtitle="Who kinfolk and invoices contact.">
              <dl className="settings__fields">
                <Field label="Business name" value={data.businessName} />
                <Field label="Email" value={data.businessEmail} />
                <Field label="Phone" value={data.businessPhone} />
                <Field label="Address" value={data.businessAddress} />
              </dl>
            </DenPanel>

            <DenPanel title="Weather area" subtitle="Coverage area for the Home weather widgets.">
              <dl className="settings__fields">
                <Field label="Area" value={data.weatherLocation} />
              </dl>
            </DenPanel>

            <DenPanel title="Business hours" subtitle="When the Den is open for visits.">
              <ul className="settings__hours">
                {businessHoursRows(data.businessHours).map((row) => (
                  <li key={row.day} className="settings__hours-row">
                    <span className="settings__hours-day">{row.day}</span>
                    <span className="settings__hours-value">{row.label}</span>
                  </li>
                ))}
              </ul>
            </DenPanel>

            <DenPanel title="Google Calendar sync" subtitle="Imports the shared calendar's busy events as private blocks.">
              <dl className="settings__fields">
                <Field label="Calendar ID" value={data.calendarSyncId} empty="Not configured" />
              </dl>
            </DenPanel>

            <DenPanel title="Time off" subtitle="Holidays the Den observes and its own closures." collapsible initiallyExpanded={false}>
              <SettingsSubheading text="US holidays observed" />
              {observedHolidayLabels(data.observedUsHolidays).length === 0 ? (
                <p className="settings__hint">No US holidays observed.</p>
              ) : (
                <ul className="settings__chips">
                  {observedHolidayLabels(data.observedUsHolidays).map((label) => (
                    <li key={label} className="settings__chip">{label}</li>
                  ))}
                </ul>
              )}

              <SettingsSubheading text="Company holidays" />
              {companyHolidayRows(data.companyHolidays).length === 0 ? (
                <p className="settings__hint">No company holidays added.</p>
              ) : (
                <ul className="settings__dated-list">
                  {companyHolidayRows(data.companyHolidays).map((row, i) => (
                    <li key={`${row.date}-${row.label}-${i}`} className="settings__dated-row">
                      <span className="settings__dated-label">{row.label}</span>
                      <span className="settings__dated-date">{row.date || 'No date'}</span>
                    </li>
                  ))}
                </ul>
              )}

              <SettingsSubheading text="Special hours" />
              {specialHourRows(data.specialHours).length === 0 ? (
                <p className="settings__hint">No special hours added.</p>
              ) : (
                <ul className="settings__dated-list">
                  {specialHourRows(data.specialHours).map((row, i) => (
                    <li key={`${row.date}-${row.label}-${i}`} className="settings__dated-row">
                      <span className="settings__dated-label">{row.label}</span>
                      <span className="settings__dated-date">{row.date || 'No date'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </DenPanel>

            <DenPanel title="KinCare types" subtitle="The service types and rates kinfolk pick when booking.">
              {serviceRateRows(data.serviceRates).length === 0 ? (
                <p className="settings__hint">No KinCare types configured.</p>
              ) : (
                <ul className="settings__dated-list">
                  {serviceRateRows(data.serviceRates).map((row) => (
                    <li key={row.type} className="settings__dated-row">
                      <span className="settings__dated-label">{row.type}</span>
                      <span className="settings__dated-date">{row.rate}</span>
                    </li>
                  ))}
                </ul>
              )}
            </DenPanel>

            <DenPanel title="Booking behavior" subtitle="How new bookings are confirmed and adjusted.">
              <dl className="settings__fields">
                <Field label="Auto-confirm repeat kinfolk" value={boolLabel(data.autoConfirmRepeatKinfolk)} />
                <Field label="Snap drag-to-reschedule to 15 min" value={boolLabel(data.snapRescheduleTo15Min)} />
              </dl>
            </DenPanel>

            <DenPanel title="Payment options" subtitle="How kinfolk pay you; each handle prints on every invoice.">
              <dl className="settings__fields">
                {paymentRows(data).map((row) => (
                  <Field key={row.label} label={row.label} value={row.value} />
                ))}
              </dl>
            </DenPanel>

            <DenPanel title="Branding" subtitle="Logo, app name, and Home greeting.">
              <dl className="settings__fields">
                {brandingRows(data).map((row) => (
                  <Field key={row.label} label={row.label} value={row.value} />
                ))}
              </dl>
            </DenPanel>

            <DenPanel title="MyTribe portal" subtitle="The kinfolk-facing portal chrome and Home layout.">
              <dl className="settings__fields">
                <Field label="Theme" value={data.mytribePortal.themeId} />
                <Field label="Top banner" value={portalBannerSummary(data.mytribePortal.banner)} />
                <Field label="Message Auntie chat" value={portalChatSummary(data.mytribePortal.chat)} />
                <Field label="Home layout" value={portalHomeSummary(data.mytribePortal.home)} />
              </dl>
            </DenPanel>
          </>
        )}
      </AsyncRegion>
    </div>
  );
}

function SettingsSubheading({ text }: { text: string }) {
  return <p className="settings__subheading">{text}</p>;
}

interface FieldProps {
  label: string;
  value: string;
  /** Shown instead of an empty value. Defaults to "Not set". */
  empty?: string;
}

/** One label/value pair. Never renders a bare empty string, which reads like a rendering bug. */
function Field({ label, value, empty = 'Not set' }: FieldProps) {
  const trimmed = value.trim();
  return (
    <div className="settings__field">
      <dt className="settings__field-label">{label}</dt>
      <dd className="settings__field-value">{trimmed === '' ? empty : trimmed}</dd>
    </div>
  );
}
