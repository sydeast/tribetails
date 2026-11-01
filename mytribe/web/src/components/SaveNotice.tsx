import { clearSaveNotice, useSaveNotice } from '../lib/saveNotice';
/**
 * #1281: the confirmation line under the portal nav. See `lib/saveNotice.ts`
 * for why it lives outside the screen that saved.
 */
export function SaveNoticeLine() {
  const notice = useSaveNotice();
  if (!notice) return null;
  return (
    <div className="savenotice" role="status" aria-live="polite">
      <div className="in">
        <span className="ico" aria-hidden="true">{'✓'}</span>
        <span className="tt">{notice.text}</span>
        <button type="button" className="x" aria-label="Dismiss" onClick={clearSaveNotice}>
          {'×'}
        </button>
      </div>
    </div>
  );
}
