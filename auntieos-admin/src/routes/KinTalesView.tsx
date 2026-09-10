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
  | { kind: 'compose'; kinTaleId?: string; sessionId?: string };

export function KinTalesView() {
  // Two entry params, two destinations, neither guessed from the other:
  //   `?kinTaleId=` opens one report in DETAIL, the destination of a kintale
  //     notification's "Open".
  //   `?sessionId=` opens the COMPOSER scaffolded from that visit, which is
  //     where Auntie Time's "Complete KinTale" button routes (#703). That visit
  //     is departed and the write-up is the next thing owed on it, so landing
  //     the operator on the list to hunt for it would be the wrong screen.
  // Initial state only, so closing either one returns to the list rather than
  // bouncing back off a stale URL.
  const { kinTaleId, sessionId } = useSearch({ from: '/admin/kintales' });
  const navigate = useNavigate();
  const [mode, setMode] = useState<KinTalesMode>(() => {
    if (kinTaleId) return { kind: 'detail', kinTaleId };
    if (sessionId) return { kind: 'compose', sessionId };
    return { kind: 'list' };
  });

  /**
   * Back to the list, and drop the entry param on the way out. Without clearing
   * it the URL keeps naming a report or a visit the operator has closed, and a
   * reload would reopen it.
   */
  function closeToList() {
    setMode({ kind: 'list' });
    if (kinTaleId || sessionId) void navigate({ to: '/kintales', search: {} });
  }

  if (mode.kind === 'compose') {
    return (
      <KinTaleCompose
        {...(mode.kinTaleId ? { kinTaleId: mode.kinTaleId } : {})}
        {...(mode.sessionId ? { sessionId: mode.sessionId } : {})}
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
