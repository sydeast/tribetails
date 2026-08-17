import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountOverlay, type OverlayHandlers } from './overlay';

/**
 * The overlay is the only part of the recorder the operator touches, and its
 * failure modes are quiet ones. A mark that records the wrong element, a hotkey
 * that does not fire on the operator's keyboard, or an unmount that leaves a
 * window listener behind all produce a walk that looks fine and explains
 * nothing. None of that is visible from reading the code, which is why it is
 * pinned here.
 */

let unmount: (() => void) | null = null;

interface Recorded {
  note: string;
  element: Element | null;
}

/** Mounts the overlay with spy handlers and registers it for teardown. */
function mount(overrides: Partial<OverlayHandlers> = {}) {
  const marks: Recorded[] = [];
  const onExport = vi.fn(async () => 'walk-portal-2026-08-16.json.gz');
  unmount = mountOverlay({
    markCount: () => marks.length,
    onMark: (note, element) => {
      marks.push({ note, element });
    },
    onExport,
    ...overrides,
  });

  const host = document.querySelector('[data-issue-recorder]') as HTMLElement;
  const root = host.shadowRoot as ShadowRoot;
  return {
    marks,
    onExport,
    host,
    root,
    dot: root.querySelector('.dot') as HTMLButtonElement,
    panel: root.querySelector('.panel') as HTMLElement,
    toast: root.querySelector('.toast') as HTMLElement,
    input: root.querySelector('input') as HTMLInputElement,
    markButton: root.querySelector('[data-act="save"]') as HTMLButtonElement,
    exportButton: root.querySelector('[data-act="export"]') as HTMLButtonElement,
  };
}

/** The hotkey as a real keyboard sends it. */
function pressHotkey(code = 'KeyX'): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { code, key: 'X', ctrlKey: true, shiftKey: true, cancelable: true });
  window.dispatchEvent(event);
  return event;
}

/** A pointer move over an element of the app, the way a browser reports one. */
function hover(el: Element): void {
  el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, composed: true }));
}

afterEach(() => {
  unmount?.();
  unmount = null;
  document.body.innerHTML = '';
});

describe('mountOverlay', () => {
  /**
   * The shadow root is not decoration. Both apps ship global stylesheets, and
   * an overlay that inherited them could restyle itself from screen to screen
   * or, worse, change the layout of the very page being reported on, so the
   * recorder would be altering the evidence.
   */
  it('renders into a shadow root rather than into the page', () => {
    const { host, root, dot } = mount();
    expect(host.shadowRoot).not.toBeNull();
    expect(root.querySelector('style')?.textContent).toContain(':host');
    // Nothing of the overlay is reachable from the document tree, which is what
    // keeps the app's stylesheets off it.
    expect(document.querySelector('.dot')).toBeNull();
    expect(dot.textContent).toContain('!');
  });

  it('starts with the panel and the toast hidden', () => {
    const { panel, toast } = mount();
    expect(panel.hidden).toBe(true);
    expect(toast.hidden).toBe(true);
  });

  it('opens the panel on the dot and closes it on a second click', () => {
    const { dot, panel } = mount();
    dot.click();
    expect(panel.hidden).toBe(false);
    dot.click();
    expect(panel.hidden).toBe(true);
  });

  /**
   * The hotkey is matched on `event.code`, not `event.key`, because with a
   * modifier held `key` is 'X' on some layouts and something else entirely on
   * others. The operator should not have to think about their keyboard layout
   * to file a bug.
   */
  it('opens the panel on Ctrl+Shift+X and swallows the keystroke', () => {
    const { panel } = mount();
    const event = pressHotkey();
    expect(panel.hidden).toBe(false);
    // Without preventDefault the browser's own Ctrl+Shift+X may act as well.
    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores the modifiers on their own and other letters', () => {
    const { panel } = mount();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyY', ctrlKey: true, shiftKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', shiftKey: true }));
    expect(panel.hidden).toBe(true);
  });

  /**
   * ONE KEYSTROKE IN, ONE KEYSTROKE OUT. The whole design is built around the
   * complaint that writing an issue down takes longer than finding it, so
   * Enter with an empty box has to be a complete, valid mark.
   */
  it('marks on Enter with no note at all', () => {
    document.body.innerHTML = `<main class="shell"><button class="btn">Book</button></main>`;
    const { marks, input, panel } = mount();
    hover(document.querySelector('button') as Element);

    pressHotkey();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(marks).toHaveLength(1);
    expect(marks[0]?.note).toBe('');
    expect((marks[0]?.element as HTMLElement).className).toBe('btn');
    expect(panel.hidden).toBe(true);
  });

  it('trims the note the operator typed', () => {
    const { marks, input } = mount();
    pressHotkey();
    input.value = '  wrong total  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(marks[0]?.note).toBe('wrong total');
  });

  it('marks on the Mark button as well as on Enter', () => {
    const { marks, markButton } = mount();
    pressHotkey();
    markButton.click();
    expect(marks).toHaveLength(1);
  });

  it('closes on Escape without recording a mark', () => {
    const { marks, input, panel } = mount();
    pressHotkey();
    input.value = 'never mind';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel.hidden).toBe(true);
    expect(marks).toEqual([]);
  });

  /**
   * The box is emptied when the panel opens, not after a mark is taken. Two
   * marks in a row otherwise carry the first one's note, which is worse than
   * no note: it is a wrong note nobody typed.
   */
  it('empties the note box each time the panel opens', () => {
    const { input } = mount();
    pressHotkey();
    input.value = 'first';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    pressHotkey();
    expect(input.value).toBe('');
  });

  it('shows the running mark count on the dot', () => {
    const { dot, input } = mount();
    expect(dot.querySelector('.count')?.textContent).toBe('0');
    pressHotkey();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(dot.querySelector('.count')?.textContent).toBe('1');
    pressHotkey();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(dot.querySelector('.count')?.textContent).toBe('2');
  });

  it('confirms a mark with a toast', () => {
    const { toast, input } = mount();
    pressHotkey();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(toast.hidden).toBe(false);
    expect(toast.textContent).toBe('Marked');
  });

  /**
   * The export is the end of the walk and the only artefact that leaves the
   * browser, so the filename has to reach the operator. "It downloaded
   * something" is not enough when the next step is finding that file on disk.
   */
  it('exports and names the file in the toast', async () => {
    const { exportButton, onExport, toast, panel } = mount();
    pressHotkey();
    exportButton.click();
    await vi.waitFor(() => expect(toast.hidden).toBe(false));

    expect(onExport).toHaveBeenCalledOnce();
    expect(toast.textContent).toBe('Exported walk-portal-2026-08-16.json.gz');
    expect(panel.hidden).toBe(true);
  });

  it('does not record a mark when the export button is pressed', async () => {
    const { exportButton, marks, onExport } = mount();
    pressHotkey();
    exportButton.click();
    await vi.waitFor(() => expect(onExport).toHaveBeenCalled());
    expect(marks).toEqual([]);
  });

  /**
   * The element is taken from the last real pointer move, not from wherever
   * the cursor sits when the panel opens. The operator's hands do not move
   * between noticing the problem and pressing the hotkey, so the last hover is
   * the thing they were looking at.
   */
  it('marks the element the pointer was last over, not the one under it now', () => {
    document.body.innerHTML = `
      <main class="shell">
        <button class="first">Book</button>
        <button class="second">Cancel</button>
      </main>
    `;
    const { marks, input } = mount();
    hover(document.querySelector('.first') as Element);
    hover(document.querySelector('.second') as Element);

    pressHotkey();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect((marks[0]?.element as HTMLElement).className).toBe('second');
  });

  it('marks a null element when the pointer never moved over the page', () => {
    const { marks, input } = mount();
    pressHotkey();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(marks[0]?.element).toBeNull();
  });

  /**
   * THE REGRESSION TEST FOR A DEFECT THAT SHIPPED, found 2026-08-16.
   *
   * The pointer guard used to read
   * `target.closest('[data-issue-recorder]') === null`, and it excluded
   * nothing. The attribute is on the HOST element while the dot and the panel
   * live inside its shadow root, and `Element.closest` walks `parentElement`,
   * which is null at the top of a shadow tree, so it never reached the host and
   * never matched.
   *
   * It bit exactly the path the README documents: click the dot to open the
   * panel, and the pointer has crossed the dot on the way, so the mark came out
   * about a `button.dot` instead of the screen. Only the Ctrl+Shift+X path was
   * unaffected, which is why manual testing missed it.
   *
   * This test was first written as `it.fails`, asserting the correct behaviour
   * so it would pass while the bug was present. That was rejected: a suite that
   * is green over a known defect is the exact thing this recorder was built to
   * stop happening elsewhere. `overlay.ts` now checks
   * `event.composedPath().includes(host)`, which is the one lookup that crosses
   * a shadow boundary, and the assertion below is an ordinary passing test.
   */
  it('does not mark the recorder own controls when the pointer crosses them', () => {
    document.body.innerHTML = `<main class="shell"><button class="btn">Book</button></main>`;
    const { marks, dot, markButton } = mount();
    hover(document.querySelector('button') as Element);
    // Exactly what happens when the operator reaches for the dot with a mouse.
    hover(dot);

    dot.click();
    markButton.click();

    expect((marks[0]?.element as HTMLElement).className).toBe('btn');
  });

  /**
   * The overlay is unmounted when the walk is stopped, in a page the operator
   * carries on using. A window listener that outlived it would keep swallowing
   * Ctrl+Shift+X, and the pointermove listener would keep running on every
   * mouse move for the rest of the page's life.
   */
  it('unmount removes the host and both window listeners', () => {
    document.body.innerHTML = `<main><button class="btn">Book</button></main>`;
    const { marks } = mount();

    unmount?.();
    unmount = null;

    expect(document.querySelector('[data-issue-recorder]')).toBeNull();
    // Neither of these may do anything now, and neither may throw.
    const event = pressHotkey();
    hover(document.querySelector('button') as Element);
    expect(event.defaultPrevented).toBe(false);
    expect(marks).toEqual([]);
  });
});
