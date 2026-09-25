import { useCallback, useEffect, useRef, useState } from 'react';
import {
  previewEmailTemplate,
  type PreviewEmailTemplateRequest,
  type PreviewEmailTemplateResult,
} from '../api/templatesWrite';

/**
 * #953: the preview beside the editor, refreshed through the server so it is
 * the email that will be sent. Debounced so a typing burst is one request; a
 * sequence number drops any answer that arrives after a newer request was
 * made, so a slow old answer can never paint over the current text. The last
 * good preview stays on screen while the next one loads.
 */
export const PREVIEW_DEBOUNCE_MS = 500;

export type EmailPreviewState =
  | { status: 'empty' }
  | { status: 'loading'; last: PreviewEmailTemplateResult | null }
  | { status: 'ready'; result: PreviewEmailTemplateResult }
  | { status: 'error'; message: string; last: PreviewEmailTemplateResult | null };

function lastOf(state: EmailPreviewState): PreviewEmailTemplateResult | null {
  if (state.status === 'ready') return state.result;
  if (state.status === 'loading' || state.status === 'error') return state.last;
  return null;
}

export function useEmailPreview(req: PreviewEmailTemplateRequest | null): {
  state: EmailPreviewState;
  retry: () => void;
} {
  const [state, setState] = useState<EmailPreviewState>({ status: 'empty' });
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  const key = req ? JSON.stringify(req) : null;

  useEffect(() => {
    const mine = ++seq.current;
    if (key === null) {
      setState({ status: 'empty' });
      return;
    }
    setState((prev) => ({ status: 'loading', last: lastOf(prev) }));
    const timer = setTimeout(() => {
      previewEmailTemplate(JSON.parse(key) as PreviewEmailTemplateRequest).then(
        (result) => {
          if (seq.current === mine) setState({ status: 'ready', result });
        },
        (err: unknown) => {
          if (seq.current !== mine) return;
          const message = err instanceof Error ? err.message : 'The preview did not load.';
          setState((prev) => ({ status: 'error', message, last: lastOf(prev) }));
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}
