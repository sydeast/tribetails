import type { WorkSettings } from '../api/workSettings';
import type { Async } from '../lib/async';
import { Banner } from './Banner';
import { GhostButton } from './Buttons';
import { LoadingRow } from './LoadingRow';

/** The words on the wait, exported so tests and screens spell it once. */
export const WORK_SETTINGS_LOADING = 'Loading the KinCare list and business clock…';
export const WORK_SETTINGS_FAILED = "Couldn't load the KinCare list and business clock";

interface Props {
  state: Async<WorkSettings>;
}

/**
 * #2164: what a work screen says while the KinCare list, the business clock
 * and the visit rules load, and if they could not be read. Renders nothing once
 * they are in.
 *
 * The failure line says which clock the times are on, because that is the one
 * thing on the screen that is now a fallback rather than the business's own.
 */
export function WorkSettingsNotice({ state }: Props) {
  if (state.status === 'ready') return null;
  if (state.status === 'loading') {
    return <LoadingRow label={WORK_SETTINGS_LOADING} className="work-settings-notice" />;
  }
  const retry = state.retry;
  return (
    <Banner
      tone="error"
      title={WORK_SETTINGS_FAILED}
      {...(retry ? { trailing: <GhostButton label="Try again" onClick={retry} /> } : {})}
    >
      Until it loads, times show on Central time and each visit shows the KinCare name it was booked under.
    </Banner>
  );
}
