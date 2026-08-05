import { useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { KinTales } from '../screens/KinTales';
import { KinTaleCompose } from '../screens/KinTaleCompose';
import { KinTaleDetail } from '../screens/KinTaleDetail';

/**
 * Three-state router wrapper, replacing the old two-state (list/compose)
 * `compose` local state now that the detail/view surface (`KinTaleDetail.tsx`)
 * exists alongside compose/edit (`KinTaleCompose.tsx`):
 *
 *   list      KinTales.tsx, the row feed.
 *   detail    KinTaleDetail.tsx, VIEWING one report: the recap, comment
 *             thread, and reaction. Reached by clicking a row (`onSelect`).
 *   compose   KinTaleCompose.tsx, EDITING (an existing `kinTaleId`) or
 *             starting a brand-new draft (`onNew`, no id).
 *
 * `onSelect` opens DETAIL, not compose: clicking a row in a list is a "view
 * this" gesture (the Inbox.tsx/Sessions.tsx convention for a row click),
 * never an implicit "start editing". Editing is its own explicit affordance,
 * `KinTaleDetail`'s own Edit button, which routes to `compose` carrying the
 * same `kinTaleId`. Both `detail` and `compose` return to `list` on close.
 */
type KinTalesMode =
  | { kind: 'list' }
  | { kind: 'detail'; kinTaleId: string }
  | { kind: 'compose'; kinTaleId?: string };

export function KinTalesView() {
  // `/kintales?kinTaleId=<id>` opens straight into DETAIL, the destination of a
  // kintale notification's "Open". Initial state only, so closing the detail
  // returns to the list rather than bouncing back off a stale URL.
  const { kinTaleId } = useSearch({ from: '/admin/kintales' });
  const navigate = useNavigate();
  const [mode, setMode] = useState<KinTalesMode>(
    kinTaleId ? { kind: 'detail', kinTaleId } : { kind: 'list' },
  );

  /**
   * Back to the list, and drop `?kinTaleId=` on the way out. Without clearing
   * the search param the URL keeps naming a report the operator has closed, and
   * a reload would reopen it.
   */
  function closeToList() {
    setMode({ kind: 'list' });
    if (kinTaleId) void navigate({ to: '/kintales', search: {} });
  }

  if (mode.kind === 'compose') {
    return (
      <KinTaleCompose
        {...(mode.kinTaleId ? { kinTaleId: mode.kinTaleId } : {})}
        onClose={closeToList}
      />
    );
  }
  if (mode.kind === 'detail') {
    return (
      <KinTaleDetail
        kinTaleId={mode.kinTaleId}
        onEdit={(id) => setMode({ kind: 'compose', kinTaleId: id })}
        onClose={closeToList}
      />
    );
  }
  return (
    <KinTales
      onNew={() => setMode({ kind: 'compose' })}
      onSelect={(id) => setMode({ kind: 'detail', kinTaleId: id })}
    />
  );
}
