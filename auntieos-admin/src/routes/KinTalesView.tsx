import { useEffect, useRef, useState } from 'react';
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { KinTales } from '../screens/KinTales';
import { isDateRangeKey } from '../components/ListToolbar';
import { KinTaleCompose } from '../screens/KinTaleCompose';
import { KinTaleDetail } from '../screens/KinTaleDetail';
import { draftIdFromListRowId } from '../lib/kinTaleList';
import { LoadingRow } from '../components/LoadingRow';

/**
 * Three-state router wrapper, replacing the old two-state (list/compose)
 * `compose` local state now that the detail/view surface (`KinTaleDetail.tsx`)
 * exists alongside compose/edit (`KinTaleCompose.tsx`):
 *
 *   list      KinTales.tsx, the row feed.
 *   detail    KinTaleDetail.tsx, VIEWING one report: the recap, comment
 *             thread, and reaction. Reached by clicking a row (`onSelect`).
 *   compose   KinTaleCompose.tsx, EDITING (an existing `kinTaleId`) or
 *             starting a brand-new draft from a visit (`?sessionId=`).
 *
 * `onSelect` opens DETAIL, not compose: clicking a row in a list is a "view
 * this" gesture (the Inbox.tsx/Sessions.tsx convention for a row click),
 * never an implicit "start editing". Editing is its own explicit affordance,
 * `KinTaleDetail`'s own Edit button, which routes to `compose` carrying the
 * same `kinTaleId`. Both `detail` and `compose` return to `list` on close.
 *
 * A DRAFT ROW IS NOT A REPORT (#1563). The list joins `generated_drafts` into
 * its Drafts bucket under namespaced ids (`generated_drafts/<id>`), and the
 * detail screen reads `kin_care_reports`, so a draft id handed to it can only
 * ever say "No KinTale found". A draft opens where drafts are reviewed and
 * sent: Communicate's Personalize, `/communicate?draftId=<bare id>`.
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
  // Closing either one drops the param, so the list does not bounce back off a
  // stale URL.
  //
  // #1594: `?range=` is the list's window, written as the operator picks one
  // (replacing the entry, so Back leaves KinTales rather than replaying every
  // window tried). A report opened from the list PUSHES `?kinTaleId=` beside
  // it, so the detail is an address of its own and Back returns to the list.
  // Close pops that entry when this mount pushed it, and otherwise (opened cold
  // from a link or a reload) replaces it with the list in the same window. The
  // list remounts on Close and reads its window from the URL, which is how the
  // filter survives instead of resetting to Last 7 days.
  const { kinTaleId, sessionId, range } = useSearch({ from: '/admin/kintales' });
  const navigate = useNavigate();
  const router = useRouter();
  const listRange = isDateRangeKey(range) ? range : undefined;
  const rangeSearch = listRange !== undefined ? { range: listRange } : {};
  // Set while a detail this mount pushed is open.
  const pushedDetail = useRef(false);
  // A draft named in the URL goes to Communicate before anything renders here.
  const linkedDraftId = kinTaleId ? draftIdFromListRowId(kinTaleId) : null;
  useEffect(() => {
    if (linkedDraftId !== null) void navigate({ to: '/communicate', search: { draftId: linkedDraftId } });
  }, [linkedDraftId, navigate]);
  const [mode, setMode] = useState<KinTalesMode>(() => {
    if (kinTaleId && draftIdFromListRowId(kinTaleId) === null) return { kind: 'detail', kinTaleId };
    if (sessionId) return { kind: 'compose', sessionId };
    return { kind: 'list' };
  });

  // The URL moving under the view (browser Back or Forward) moves the view.
  // Only a CHANGE of `kinTaleId` counts, so a view that set its own mode, and
  // the URL it wrote, are never second-guessed.
  const seenKinTaleId = useRef(kinTaleId);
  useEffect(() => {
    if (seenKinTaleId.current === kinTaleId) return;
    seenKinTaleId.current = kinTaleId;
    if (kinTaleId && draftIdFromListRowId(kinTaleId) === null) {
      setMode({ kind: 'detail', kinTaleId });
    } else if (!kinTaleId) {
      pushedDetail.current = false;
      setMode((m) => (m.kind === 'detail' ? { kind: 'list' } : m));
    }
  }, [kinTaleId]);

  /**
   * Back to the list in the window it was in, and drop the entry param on the
   * way out. Without clearing it the URL keeps naming a report or a visit the
   * operator has closed, and a reload would reopen it.
   */
  function closeToList() {
    setMode({ kind: 'list' });
    if (pushedDetail.current) {
      pushedDetail.current = false;
      seenKinTaleId.current = undefined;
      router.history.back();
      return;
    }
    if (kinTaleId || sessionId) {
      seenKinTaleId.current = undefined;
      void navigate({ to: '/kintales', search: rangeSearch, replace: true });
    }
  }

  if (linkedDraftId !== null) return <LoadingRow label="Opening the draft…" />;
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
        onDeleted={closeToList}
        onClose={closeToList}
      />
    );
  }
  // No `onNew`: a KinTale is only ever started from a Kin Care (operator
  // ruling 2026-09-10, #676), and that entry is Auntie Time's "Complete
  // KinTale", which lands here with `?sessionId=`. The list offers no blank
  // composer of its own.
  return (
    <KinTales
      onSelect={(id) => {
        const draftId = draftIdFromListRowId(id);
        if (draftId !== null) {
          void navigate({ to: '/communicate', search: { draftId } });
          return;
        }
        setMode({ kind: 'detail', kinTaleId: id });
        pushedDetail.current = true;
        seenKinTaleId.current = id;
        void navigate({ to: '/kintales', search: { ...rangeSearch, kinTaleId: id } });
      }}
      onRangeChange={(next) => void navigate({ to: '/kintales', search: { range: next }, replace: true })}
      {...(listRange !== undefined ? { initialRange: listRange } : {})}
    />
  );
}
