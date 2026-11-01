import type { MutableRefObject } from 'react';
/** How one card's part of the page Save went. `message` is the card's own sentence, ready to show. */
export type CardSaveResult = { ok: true } | { ok: false; message: string };
/**
 * What a card hands the Tribe Profile page so the page's one Save button can
 * save it too (#1324). The card keeps its own form state and its own callable;
 * the page only asks "do you have edits?" and "save them", then reports the
 * answer on the single status line. The card does not render a Save button.
 */
export interface CardSave {
  /** True while the card holds edits the server has not seen. */
  dirty: boolean;
  save: () => Promise<CardSaveResult>;
}
export type CardSaveRef = MutableRefObject<CardSave | null>;
