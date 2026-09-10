import { useRouter } from '@tanstack/react-router';

/** What a Back control needs: where it goes, and what it may honestly call itself. */
export interface HistoryBack {
  /** True when the entry behind this one was pushed by this admin session. */
  canGoBack: boolean;
  /**
   * The button text. "Back" when history answers, because the destination is
   * whatever the operator was looking at and this screen cannot name it;
   * "Back to {fallbackLabel}" only when the fallback is what will actually run.
   */
  label: string;
  /** Step back through router history, or run the fallback when nothing is behind us. */
  goBack: () => void;
}

export interface HistoryBackOptions {
  /**
   * Names the fallback destination, WITHOUT the "Back to" prefix ("Directory",
   * "the Wrens"). Only ever read when there is no history to return to, so it
   * can never put a claim on the button that the click will not honour.
   */
  fallbackLabel: string;
  /** Run when there is no in-app entry behind this one. Usually a `navigate`. */
  onFallback: () => void;
}

/**
 * Back that returns to the page the operator came from (#689).
 *
 * The operator's ruling: "the back btn should go back to the user's last page
 * visit before the current". Every Back in the admin used to be a hardcoded
 * destination, so a screen reachable from four places sent all four of them to
 * the same fifth place, and said so on the button even when it was wrong.
 *
 * HOW "INSIDE THE ADMIN" IS DECIDED. `router.history.canGoBack()` is
 * `location.state.__TSR_index !== 0`, and that index is stamped by TanStack on
 * the entries IT pushes. A cold arrival, whether typed, bookmarked, restored, or
 * followed in from another site, gets its state replaced with index 0
 * (`createBrowserHistory`), so a non-zero index means at least one in-app
 * navigation has happened in this tab and the entry behind us is one of ours.
 * That is what keeps `history.back()` from throwing the operator out of the
 * admin and onto whatever site they were reading before it.
 *
 * ONLY FOR A BACK THAT LEAVES THE ROUTE. A sub-view held in local state
 * (SessionDetail inside Sessions, ConversationThread inside Inbox) pushed no
 * history entry when it opened, so `canGoBack()` there answers about the
 * navigation that reached the LIST, and stepping back would close the whole
 * screen instead of the detail. Those keep their own close handler.
 */
export function useHistoryBack({ fallbackLabel, onFallback }: HistoryBackOptions): HistoryBack {
  const router = useRouter();
  const canGoBack = router.history.canGoBack();
  return {
    canGoBack,
    label: canGoBack ? 'Back' : `Back to ${fallbackLabel}`,
    goBack: () => {
      // Re-asked at click time rather than trusting the render-time answer: a
      // click is the only moment whose answer has to be right.
      if (router.history.canGoBack()) router.history.back();
      else onFallback();
    },
  };
}
