import { Spinner } from './Spinner';
import './Spinner.css';

interface LoadingRowProps {
  /** The sentence shown next to the spinner, and the spinner's accessible name. */
  label: string;
  className?: string;
}

/**
 * A spinner paired with a short sentence: the row every settings section that
 * waits on a callable should show while it is in flight (issue #714), in place
 * of a bare hint sentence with nothing moving.
 *
 * Renders no role of its own. The caller already has a live region around its
 * loading branch (AsyncRegion's wrapper, or a hand-rolled `role="status"` on the
 * branch itself), and nesting a second one here would announce the same
 * sentence twice.
 */
export function LoadingRow({ label, className }: LoadingRowProps) {
  return (
    <p className={className ? `loadingRow ${className}` : 'loadingRow'}>
      <Spinner label={label} />
      <span aria-hidden="true">{label}</span>
    </p>
  );
}
