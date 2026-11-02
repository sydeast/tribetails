import { useEffect, useId, useRef, useState } from 'react';

/**
 * Small info icon beside the card title. `title` covers a mouse hover; a tap
 * toggles the sentence open, because a phone has no hover and iOS kinfolk only
 * have this web portal (portal Android's `KinInfoTip` opens on a tap too).
 *
 * A tap anywhere outside closes it. `onBlur` alone is not enough: iOS Safari
 * does not focus a tapped button, so it never blurs and the tip stayed open.
 */
export function InfoTip({ text, label }: { text: string; label: string }) {
  const [open, setOpen] = useState(false);
  const tipId = useId();
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (e: Event) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    return () => document.removeEventListener('pointerdown', closeOnOutside);
  }, [open]);

  return (
    <span className="ec-tip" ref={ref}>
      <button
        type="button"
        className="ec-tip__icon"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        title={text}
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        i
      </button>
      {open && (
        <span id={tipId} role="tooltip" className="ec-tip__text">
          {text}
        </span>
      )}
    </span>
  );
}
