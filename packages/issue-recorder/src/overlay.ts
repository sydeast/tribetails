/**
 * The only part of this the operator touches.
 *
 * DESIGNED AROUND ONE COMPLAINT: writing an issue down takes longer than
 * finding it, so issues stop getting written down. The interaction is therefore
 * one keystroke with nothing required after it. Type three words if they help,
 * or press Enter and keep walking; the recorder already has the route, the
 * console, the callables and the element, which is the part that used to take
 * paragraphs to explain.
 *
 * IT RENDERS INTO A SHADOW ROOT. The apps it mounts into have their own global
 * stylesheets, and an overlay that inherited them would restyle itself
 * unpredictably from screen to screen, or worse, change the layout of the very
 * page being reported on.
 */

export interface OverlayHandlers {
  onMark: (note: string, element: Element | null) => void;
  onExport: () => Promise<string>;
  markCount: () => number;
}

const HOTKEY_LABEL = 'Ctrl+Shift+X';

const STYLE = `
:host { all: initial; }
.dot, .panel, .toast { font: 13px/1.4 ui-sans-serif, system-ui, sans-serif; }
.dot {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
  width: 44px; height: 44px; border-radius: 50%; border: 0;
  background: #c2410c; color: #fff; cursor: pointer;
  box-shadow: 0 6px 20px rgba(0,0,0,.35);
  display: grid; place-items: center; font-weight: 600;
}
.dot:hover { background: #9a3412; }
.dot .count {
  position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px;
  border-radius: 9px; background: #111; color: #fff; font-size: 11px;
  display: grid; place-items: center; padding: 0 4px;
}
.panel {
  position: fixed; right: 18px; bottom: 74px; z-index: 2147483647;
  width: 320px; background: #1c1917; color: #fafaf9;
  border-radius: 10px; padding: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.45);
}
.panel[hidden] { display: none; }
.panel h2 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
.panel input {
  width: 100%; box-sizing: border-box; padding: 8px; border-radius: 6px;
  border: 1px solid #44403c; background: #0c0a09; color: #fafaf9; font: inherit;
}
.panel .hint { margin: 8px 0 0; font-size: 11px; color: #a8a29e; }
.panel .row { display: flex; gap: 8px; margin-top: 10px; }
.panel button {
  flex: 1; padding: 7px; border-radius: 6px; border: 1px solid #44403c;
  background: #292524; color: #fafaf9; font: inherit; cursor: pointer;
}
.panel button.primary { background: #c2410c; border-color: #c2410c; }
.toast {
  position: fixed; right: 18px; bottom: 74px; z-index: 2147483647;
  background: #14532d; color: #fff; padding: 9px 12px; border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0,0,0,.35);
}
.toast[hidden] { display: none; }
`;

export function mountOverlay(handlers: OverlayHandlers): () => void {
  const host = document.createElement('div');
  host.setAttribute('data-issue-recorder', '');
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  root.append(style);

  const dot = document.createElement('button');
  dot.className = 'dot';
  dot.type = 'button';
  dot.title = `Mark something wrong (${HOTKEY_LABEL})`;
  dot.textContent = '!';
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = '0';
  dot.append(count);

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.hidden = true;
  panel.innerHTML = `
    <h2>What is wrong here?</h2>
    <input type="text" placeholder="three words, or just press Enter" />
    <p class="hint">Route, console, callables and the element you were pointing at are already captured.</p>
    <div class="row">
      <button type="button" data-act="save" class="primary">Mark</button>
      <button type="button" data-act="export">End walk &amp; export</button>
    </div>
  `;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.hidden = true;

  root.append(dot, panel, toast);
  document.body.append(host);

  const input = panel.querySelector('input') as HTMLInputElement;

  /**
   * The element the mark is about.
   *
   * Captured on the last real pointer move, NOT when the panel opens: by then
   * the pointer is over the panel, and every mark would be about the recorder's
   * own button. Kept live so the hotkey path has it too.
   */
  let lastHovered: Element | null = null;
  const onPointerMove = (event: PointerEvent) => {
    const target = event.composedPath()[0];
    if (target instanceof Element && target.closest('[data-issue-recorder]') === null) {
      lastHovered = target;
    }
  };
  window.addEventListener('pointermove', onPointerMove, { passive: true, capture: true });

  const flash = (message: string) => {
    toast.textContent = message;
    toast.hidden = false;
    setTimeout(() => {
      toast.hidden = true;
    }, 2500);
  };

  const openPanel = () => {
    panel.hidden = false;
    input.value = '';
    input.focus();
  };

  const commit = () => {
    handlers.onMark(input.value.trim(), lastHovered);
    count.textContent = String(handlers.markCount());
    panel.hidden = true;
    flash('Marked');
  };

  dot.addEventListener('click', () => {
    if (panel.hidden) openPanel();
    else panel.hidden = true;
  });

  panel.addEventListener('click', (event) => {
    const act = (event.target as HTMLElement).dataset.act;
    if (act === 'save') commit();
    if (act === 'export') {
      void handlers.onExport().then((filename) => {
        panel.hidden = true;
        flash(`Exported ${filename}`);
      });
    }
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') commit();
    if (event.key === 'Escape') panel.hidden = true;
  });

  const onHotkey = (event: KeyboardEvent) => {
    // `event.code`, not `event.key`: with a modifier held, `key` is 'X' on some
    // layouts and something else entirely on others, and the operator should
    // not have to think about their keyboard to file a bug.
    if (event.ctrlKey && event.shiftKey && event.code === 'KeyX') {
      event.preventDefault();
      openPanel();
    }
  };
  window.addEventListener('keydown', onHotkey, true);

  return () => {
    window.removeEventListener('keydown', onHotkey, true);
    window.removeEventListener('pointermove', onPointerMove, true);
    host.remove();
  };
}
