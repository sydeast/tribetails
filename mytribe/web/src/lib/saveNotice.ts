import { useSyncExternalStore } from 'react';

/**
 * #1281: the sentence that says a save worked, carried across a navigation.
 *
 * Create Booking ends by moving the household to /schedule, so a confirmation
 * held in the wizard's own state would be unmounted along with the wizard. This
 * one lives at module level and `PortalNav` draws it on whichever screen comes
 * next, so "Booking requested" is still on screen after the move.
 *
 * One notice at a time; a newer one replaces it. It clears itself after
 * {@link SAVE_NOTICE_MS} or when dismissed.
 */
export const SAVE_NOTICE_MS = 8_000;

export interface SaveNotice {
  id: number;
  text: string;
}

let current: SaveNotice | null = null;
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Shows `text` as the confirmation of a save that has finished. */
export function announceSaved(text: string): void {
  if (timer) clearTimeout(timer);
  const notice = { id: nextId++, text };
  current = notice;
  timer = setTimeout(() => {
    if (current?.id === notice.id) {
      current = null;
      emit();
    }
  }, SAVE_NOTICE_MS);
  emit();
}

export function clearSaveNotice(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  current = null;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSaveNotice(): SaveNotice | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}
