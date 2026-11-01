import type { QueryClient, QueryKey } from '@tanstack/react-query';
/**
 * #1281: refetch what a save changed and WAIT for it, so the control that
 * saved stays on its busy label until the screen shows the saved data.
 *
 * The defect this replaces was `void queryClient.invalidateQueries(...)` in a
 * mutation's `onSuccess`: the mutation settled at once, the button went back
 * to its resting label, and the screen kept the pre-save data until the
 * refetch landed seconds later. "Save to Account Balance" read exactly like a
 * failed save, so households pressed it again.
 *
 * Awaited from `onSuccess`, this holds the mutation pending (TanStack awaits
 * a returned promise before it settles). `refetchType: 'all'` refetches the
 * query even when no screen is observing it, which matters when the save then
 * navigates to the screen that reads it.
 *
 * A failed refetch is swallowed: the save succeeded, and a household must not
 * be told otherwise because the read behind it failed.
 */
export async function refreshAfterSave(queryClient: QueryClient, ...keys: QueryKey[]): Promise<void> {
  try {
    await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey, refetchType: 'all' })));
  } catch {
    /* the write succeeded; the screen catches up on its next read */
  }
}
