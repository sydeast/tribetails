import type { ReactNode } from 'react';
import type { BusinessSettings } from '../../api/settings';
import { type Async } from '../../lib/async';
import { AsyncRegion } from '../../components/AsyncRegion';
import { CalendarSyncSection } from './CalendarSyncSection';
import { GoogleCalendarSection } from './GoogleCalendarSection';

/**
 * Calendar, as ONE settings section with two sub-headed areas.
 *
 * Until 2026-07-31 these were two nav items, "Calendar sync" and "Google
 * Calendar (editable)", on the reasoning that they are two features which fail
 * separately. That reasoning is still right and is still visible here: two
 * panels, two receipts, two failure states. What it got wrong is the nav. An
 * operator looking for "the Google calendar thing" has one question and was
 * given two answers to choose between with no way to know which, and a name that
 * only makes sense once you already know the difference between a service
 * account reading busy time and an OAuth grant writing events.
 *
 * WHY THE TWO HALVES ARE NOT WRAPPED IN ONE AsyncRegion. The free/busy id lives
 * in `business_settings`, which the Settings shell loads once and hands down.
 * The OAuth connection lives in a document `firestore.rules` denies to every
 * client, so that half asks a callable and loads itself. Putting both under the
 * shell's load state would take the OAuth panel down whenever
 * `business_settings` was unreadable, which is a fault it has nothing to do
 * with. Each half shows its own loading and its own error, which is what it did
 * as two sections and what merging them must not cost.
 *
 * ORDER IS DELIBERATE. Import first: it is the one that needs no secret, works
 * today, and is what most operators came for. The editable half is second and
 * carries its own setup checklist, since it is the only surface in the app gated
 * on secrets a human sets by hand.
 */

interface CalendarSectionProps {
  settings: Async<BusinessSettings>;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}

export function CalendarSection({ settings, onSave }: CalendarSectionProps): ReactNode {
  return (
    <>
      <AsyncRegion
        state={settings}
        what="business settings"
        isEmpty={() => false}
        loading={<p className="settings__hint">Loading business settings…</p>}
        empty={<p className="settings__hint">No settings found.</p>}
      >
        {(data) => <CalendarSyncSection data={data} onSave={onSave} />}
      </AsyncRegion>
      <GoogleCalendarSection />
    </>
  );
}
