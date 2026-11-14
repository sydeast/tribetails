import { type VisitLifecycleAction } from '../api/sessionsWrite';
import { clockStepWarning, type ClockStepSession } from '../lib/clockStepWarning';
import { Banner } from './Banner';

/**
 * #2039: the warning a clock confirm carries when the tap does not fit the
 * booking (`lib/clockStepWarning.ts`). Nothing at all when it fits. The clock
 * is read when the confirm opens, which is when the question is asked.
 */
export function ClockStepWarningLine({
  action,
  session,
  businessZone,
  nowMs = Date.now(),
}: {
  action: VisitLifecycleAction;
  session: ClockStepSession;
  businessZone: string;
  nowMs?: number;
}) {
  const warning = clockStepWarning(action, session, nowMs, businessZone);
  if (warning === null) return null;
  return (
    <Banner tone="warning" title="Check the time" className="clock-step-warning">
      <p>{warning}</p>
    </Banner>
  );
}
