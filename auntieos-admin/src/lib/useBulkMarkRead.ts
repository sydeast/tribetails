import { useEffect, useState } from 'react';
import { bulkMarkNotificationsRead } from '../api/notifications';
import { type Async } from './async';

/**
 * The multi-select + `bulkMarkNotificationsRead` behaviour shared by the
 * Notifications SCREEN and the Inbox's Notifications digest strip.
 *
 * Both surfaces need identical, easy-to-get-wrong handling:
 *  - prune selected ids that have left the live stream, so the count never
 *    lies about what is actually selected (a row can scroll out of the
 *    listener's 200-row cap, or be archived from another tab);
 *  - refuse to clear the selection when the write FAILED, so a failed batch
 *    stays retryable instead of quietly vanishing;
 *  - report a PARTIAL batch, since the callable skips ids that are missing,
 *    already read, or not the caller's, and returns how many it really marked.
 *
 * Extracted rather than copied: two implementations of "which rows are
 * selected" is exactly how the two screens would drift.
 */
export interface BulkMarkRead {
  selectedIds: ReadonlySet<string>;
  /** Add/remove one id from the selection. */
  toggle: (id: string, checked: boolean) => void;
  /**
   * Select exactly these ids, replacing whatever was selected.
   *
   * Takes the ids explicitly rather than reaching for the whole stream, because
   * the caller is the only one that knows which rows are actually ON SCREEN.
   * Android's "Select all" selects from the unfiltered list while its checkboxes
   * render only on the filtered rows, so a select-all-then-dismiss under an
   * active filter acts on notifications the operator never saw. Passing the
   * visible set in makes that mistake unavailable here.
   */
  selectAll: (ids: readonly string[]) => void;
  clear: () => void;
  /** True while a batch write is in flight. */
  busy: boolean;
  /** Fail-loud message for the caller to render; also settable for sibling actions. */
  error: string | null;
  setError: (message: string | null) => void;
  /**
   * Marks the selection read. Pass an explicit subset to send FEWER ids than are
   * selected, which the Notifications screen does with the unread ones only.
   *
   * Why that matters: the callable skips rows that are already read and reports
   * how many it really marked, so a selection containing read rows comes back
   * partial and the partial-batch sentence below fires on a batch in which
   * nothing failed. Narrowing what is SENT (not what is selected) makes the
   * report accurate again. The whole selection still clears on success, because
   * the operator's intent was the whole selection either way.
   *
   * Omitting the argument sends the entire selection, which is what the Inbox
   * digest strip does.
   */
  markSelectedRead: (ids?: readonly string[]) => Promise<void>;
}

export function useBulkMarkRead(rows: Async<readonly { _id: string }[]>): BulkMarkRead {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Drop any selected id that has left the live list. Deliberately runs ONLY
  // on a resolved stream: a failed or in-flight read is not evidence that a
  // row is gone, so an error must not silently empty the selection.
  useEffect(() => {
    if (rows.status !== 'ready') return;
    const live = new Set(rows.data.map((r) => r._id));
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  function toggle(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function markSelectedRead(only?: readonly string[]) {
    const ids = only === undefined ? [...selectedIds] : [...only];
    if (ids.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const marked = await bulkMarkNotificationsRead(ids);
      setSelectedIds(new Set());
      if (marked < ids.length) {
        setError(
          `Marked ${marked} of ${ids.length}, the rest were already read or not yours to mark.`,
        );
      }
    } catch (err) {
      // Selection intentionally survives a failure so the operator can retry.
      setError(err instanceof Error ? err.message : 'Marking notifications read failed.');
    } finally {
      setBusy(false);
    }
  }

  return {
    selectedIds,
    toggle,
    selectAll: (ids: readonly string[]) => setSelectedIds(new Set(ids)),
    clear: () => setSelectedIds(new Set()),
    busy,
    error,
    setError,
    markSelectedRead,
  };
}
