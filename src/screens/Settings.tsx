import { useCallback, useEffect, useState } from 'react';
import { getBusinessSettings, type BusinessSettings } from '../api/settings';
import { type Async } from '../lib/async';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { PrimaryButton } from '../components/Buttons';
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
  /** Placeholder: the editor surface doesn't exist yet (edit/save is out of scope for this port). */
  onEdit?: () => void;
}

/**
 * Admin Settings, READ-ONLY OVERVIEW. Displays the current `business_settings`
 * document, grouped by the same sections the wasm `SettingsScreen.kt` editor
 * uses, but with every field/save action removed. Editing (and the per-section
 * Save bars, the vet-clinic CRUD, the live notification-gate matrix, and the
 * per-operator Appearance/Security panels, none of which live on this single
 * doc) is the deferred, not-yet-built surface, exactly as `onEdit` here is a
 * placeholder prop for routing to it later (matches the `onSelect`/`onNew`
 * convention in FormSchemas.tsx).
 *
 * Loads once via the one-shot `getBusinessSettings` (a direct Firestore
 * `getDoc`, not a callable, see `api/settings.ts`'s header for why), not a
 * live listener: an overview does not need to react to a concurrent editor's
 * writes, since there is no concurrent editor yet.
 */
export function Settings({ onEdit }: SettingsProps) {
  const [settings, setSettings] = useState<Async<BusinessSettings>>({ status: 'loading' });

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

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Admin"
        title="Settings"
        accentTail="overview."
        subtitle="What's currently saved on your business settings, grouped by section."
        trailing={
          <PrimaryButton label="Edit settings" {...(onEdit ? { onClick: () => onEdit() } : {})} />
        }
      />

      <Banner tone="info" dashed pillLabel="Read-only">
        This is an overview, not the editor. Values below are exactly what&rsquo;s saved; changing
        them here is not available yet.
      </Banner>

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
