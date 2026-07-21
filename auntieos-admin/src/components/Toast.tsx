import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import './Toast.css';

/**
 * Transient confirmations ONLY.
 *
 * There is deliberately no 'error' tone. This app's fail-loud policy puts every
 * failure in a persistent surface the operator has to look at: Banner for an
 * action that failed, AsyncRegion for a read that failed. KinTaleCompose says so
 * in its own source, that its load-error banner is "not a toast". A toast that
 * dismisses itself after five seconds is the wrong home for a failure, because
 * the operator who stepped away never learns it happened.
 *
 * So the type is the guard rail: you cannot toast an error, and reviewers do not
 * have to remember the rule. Success and info dismiss themselves; errors do not.
 */
export type ToastTone = 'success' | 'info';

export interface ToastOptions {
  tone?: ToastTone;
  /** Milliseconds before auto-dismiss. Ignored while hovered or focused. */
  durationMs?: number;
}

interface ToastEntry {
  id: number;
  message: string;
  tone: ToastTone;
  durationMs: number;
}

const DEFAULT_DURATION_MS = 5000;

/**
 * Oldest drops first past this. A stack taller than the eye can read in one
 * glance is the same as no message at all, and it starts covering the screen it
 * is reporting on.
 */
const MAX_VISIBLE = 3;

interface ToastApi {
  showToast: (message: string, options?: ToastOptions) => void;
  dismissToast: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * The confirmation surface. Wrap the app once, at the root, above the router so
 * a toast survives navigation (saving on one screen and landing on another still
 * confirms).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  // A counter, not Date.now() or Math.random(): two toasts raised in the same
  // tick would collide on a timestamp and React would reuse one key for both.
  const nextId = useRef(1);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback((message: string, options?: ToastOptions) => {
    const trimmed = message.trim();
    // An empty toast is a bug at the call site, not something to render blank.
    if (trimmed === '') return;

    setToasts((current) => {
      const entry: ToastEntry = {
        id: nextId.current++,
        message: trimmed,
        tone: options?.tone ?? 'success',
        durationMs: options?.durationMs ?? DEFAULT_DURATION_MS,
      };
      return [...current, entry].slice(-MAX_VISIBLE);
    });
  }, []);

  const api = useMemo<ToastApi>(() => ({ showToast, dismissToast }), [showToast, dismissToast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

/**
 * Raise a confirmation. Throws when used outside the provider rather than
 * no-op'ing, because a silently swallowed confirmation looks exactly like a
 * save that did not happen.
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error('useToast must be used inside a <ToastProvider>. Wrap the app root.');
  }
  return ctx;
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastEntry[];
  onDismiss: (id: number) => void;
}) {
  // aria-live lives on the container, which must be in the DOM before the first
  // message arrives. A live region mounted at the same moment as its content is
  // not announced by most screen readers.
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastEntry;
  onDismiss: (id: number) => void;
}) {
  // Hovering or focusing holds the toast open. Otherwise a toast carrying an
  // Undo, or one being read, vanishes from under the pointer reaching for it.
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (held) return undefined;
    const timer = setTimeout(() => onDismiss(toast.id), toast.durationMs);
    return () => clearTimeout(timer);
  }, [held, toast.id, toast.durationMs, onDismiss]);

  return (
    <div
      className={`toast toast--${toast.tone}`}
      role="status"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocusCapture={() => setHeld(true)}
      onBlurCapture={() => setHeld(false)}
    >
      <p className="toast__message">{toast.message}</p>
      <button
        type="button"
        className="toast__dismiss"
        onClick={() => onDismiss(toast.id)}
        aria-label={`Dismiss: ${toast.message}`}
      >
        <span aria-hidden="true">x</span>
      </button>
    </div>
  );
}
