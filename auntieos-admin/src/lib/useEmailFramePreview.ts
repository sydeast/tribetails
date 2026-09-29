import { useCallback, useEffect, useRef, useState } from 'react';
import { previewEmailFrame, type StoredEmailFrame } from '../api/emailFrame';
import { PREVIEW_DEBOUNCE_MS, type EmailPreviewState } from './useEmailPreview';
import type { PreviewEmailTemplateResult } from '../api/templatesWrite';

/**
 * #957: the frame editor's preview, rendered by the server with the real
 * frame code (`previewEmailFrame`), so it cannot differ from what is sent.
 * Same shape and behavior as the template editor's `useEmailPreview`, so both
 * use `EmailPreviewPane`: debounced, a sequence number drops a stale answer,
 * and the last good render stays up while the next one loads.
 *
 * `frame` null means the draft has a field the server would refuse; the
 * request is held back rather than sent to fail, and the last render stays.
 */
function lastOf(state: EmailPreviewState): PreviewEmailTemplateResult | null {
  if (state.status === 'ready') return state.result;
  if (state.status === 'loading' || state.status === 'error') return state.last;
  return null;
}

export function useEmailFramePreview(frame: StoredEmailFrame | null): { state: EmailPreviewState; retry: () => void } {
  const [state, setState] = useState<EmailPreviewState>({ status: 'loading', last: null });
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  const key = frame ? JSON.stringify(frame) : null;

  useEffect(() => {
    if (key === null) return;
    const mine = ++seq.current;
    setState((prev) => ({ status: 'loading', last: lastOf(prev) }));
    const timer = setTimeout(() => {
      previewEmailFrame(JSON.parse(key) as StoredEmailFrame).then(
        (res) => {
          if (seq.current === mine) setState({ status: 'ready', result: { ...res, issues: [] } });
        },
        (err: unknown) => {
          if (seq.current !== mine) return;
          const message = err instanceof Error ? err.message : 'The preview did not load.';
          setState((prev) => ({ status: 'error', message, last: lastOf(prev) }));
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}
