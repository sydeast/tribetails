import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog } from './Dialog';
import { Banner } from './Banner';
import { PrimaryButton, GhostButton } from './Buttons';
import {
  errorTotal,
  firstStepWithErrors,
  nextStepKey,
  prevStepKey,
  resolveStepKey,
  stepPosition,
  type WizardStepState,
} from '../lib/wizardFlow';
import './WizardModal.css';

/**
 * A long form, split across named steps inside one modal.
 *
 * WHY THIS EXISTS. The 2026-08-06 layout review named the KinTale template
 * editor the tallest screen in the mock set, with the Form Schema editor close
 * behind: both are always-expanded single-column forms an operator scrolls for
 * a very long time. The operator's answer was "a workflow modal with each
 * section as its own page/screen", and this is that, built once for both rather
 * than twice.
 *
 * WHAT IT IS NOT, said out loud because a PR that did the other thing was
 * closed by operator ruling on 2026-08-08: it is not a disclosure. Folding
 * sections behind an "Advanced" toggle was rejected, because the mocks draw
 * every field expanded. Splitting fields across explicit, named, directly
 * navigable steps is a different answer, and the difference is that on any
 * given step every field that step owns is drawn in full. Nothing here hides a
 * field inside the step it lives on, and adopters must not either.
 *
 * THE FIVE THINGS IT GUARANTEES:
 *
 *  1. Every field is drawn on its step. This renders `step.body` whole.
 *  2. The rail says where you are and how far is left, and every step is a real
 *     button. An operator fixing one field does not walk four screens to reach
 *     it. There is no forward gating: an editor's sections do not depend on each
 *     other the way a booking's do (see `lib/wizardFlow.ts`).
 *  3. Nothing is lost moving between steps. The CALLER owns the form state, so
 *     navigation cannot drop it, and leaving with unsaved work asks first
 *     (`dirty`), through the one `requestClose` every exit route goes through:
 *     Cancel, the close X, Escape, and the backdrop.
 *  4. Validation belongs to the step that owns the field. `step.errors` are
 *     listed on that step, and counted into that step's rail button's
 *     ACCESSIBLE NAME, so a broken step is identifiable from the rail instead of
 *     discovered by walking. Finish is disabled while any step is unclean and
 *     says how many problems remain.
 *  5. Accessibility. The rail is a `<nav>` with a name; the current step carries
 *     `aria-current="step"`; focus moves to the new step's heading on change;
 *     and the modal is `Dialog`, so the focus trap, the focus restore, Escape
 *     and the labelled `role="dialog"` are the ones the whole admin already
 *     shares rather than a second hand-rolled set.
 *
 * ON A PHONE the rail keeps every step as a real control and becomes a
 * horizontally scrollable strip of numbered pills, with the labels dropped below
 * 30rem so nine steps do not become nine lines. "Step 2 of 3" sits above it and
 * never scrolls away, so position is legible even when the current pill is off
 * the strip; the strip scrolls the current pill into view on change. A rail that
 * only fits a desktop would be a desktop-only feature, which is why the count
 * line — not the rail — is the thing that always answers "where am I".
 *
 * STEPS ARE DATA, passed on every render. A caller whose sections switch on and
 * off (the KinTale editor's `checklistEnabled` / `petMoodEnabled`) filters the
 * array, and `resolveStepKey` keeps the operator somewhere sensible when the
 * step under their feet disappears.
 */

export interface WizardStep {
  /** Stable identity; navigation is expressed in these, not in indices. */
  key: string;
  /** The rail's short name. */
  label: string;
  /** The step's own heading. Defaults to `label`. */
  heading?: string;
  /** One line under the heading saying what this step is for. */
  blurb?: string;
  /**
   * Everything the operator must fix on THIS step. Listed on the step and
   * counted onto its rail button. Empty (the default) means clean.
   *
   * Always the TRUTH, even while `pristine` keeps it quiet: the finish gate and
   * the jump to the first problem both read this list, so a caller that
   * censored it here would be disarming the guard rather than delaying a
   * sentence.
   */
  errors?: readonly string[];
  /**
   * "Nothing has happened on this step yet." While true, this step's `errors`
   * are not spoken: no banner on the step, no flag on the rail, and nothing in
   * the count beside the finish button.
   *
   * WHY. An error tells the operator that something they did needs undoing, and
   * a form they have only just opened is not that. The screenshot review of
   * 2026-08-09 caught this wizard greeting a brand new form schema with "Fix on
   * this step: Schema id is required. Schema name is required." and "3 things
   * left to fix" before a single keystroke. Pre-emptive telling-off misreads the
   * situation and trains the operator to ignore the banner that will matter.
   *
   * It delays the sentence, never the guard. Every problem is still counted
   * against the finish button, and the FIRST finish attempt reveals all of them
   * and lands the operator on the earliest one, so the only route to a save is
   * still to have nothing left to fix.
   *
   * Default false, which is a caller saying "these errors describe the record,
   * not the typing": what an editor holding a document it LOADED wants, since
   * that record was already broken when it arrived.
   */
  pristine?: boolean;
  /** The step's fields, drawn in full. Never fold any of them away. */
  body: ReactNode;
}

export interface WizardModalProps {
  /** Names the modal and, suffixed with "steps", the rail. */
  title: string;
  steps: readonly WizardStep[];
  /** Controlled: the caller owns which step is showing, so a failed save can jump to the problem. */
  currentStepKey: string;
  onStepChange: (key: string) => void;
  /** Called only once the unsaved-work guard is satisfied. */
  onClose: () => void;
  /** True when there is work that closing would throw away. */
  dirty?: boolean;
  /** The commit. Offered on the last step, and reachable from anywhere in one rail click. */
  onFinish: () => void;
  finishLabel: string;
  /** In-flight commit: the whole footer goes inert rather than offering a second submit. */
  finishBusy?: boolean;
  /** A reason to refuse the commit that is not a step's own validation (e.g. still loading). */
  finishDisabled?: boolean;
  /**
   * Banners that belong to the WHOLE flow rather than to one step — a save that
   * the server refused, a warning about how the record was loaded. Drawn above
   * the rail and therefore present on every step, because a refusal an operator
   * can only see from step 2 is a refusal they will miss.
   */
  notice?: ReactNode;
  /**
   * A panel that stays beside the step body on EVERY step: context, not a step.
   * The form schema editor's live preview is the case this exists for, a
   * preview whose whole value is being visible while the fields it previews are
   * being typed, and the Kinfolk portal's booking wizard keeps a persistent
   * summary/price rail for the same reason.
   *
   * Sticky beside the body on a wide modal, stacked underneath it below 64rem:
   * a preview pinned over the fields it previews on a phone is in the way
   * rather than useful, which is the rule the pane already had before the
   * editor became a wizard.
   */
  aside?: ReactNode;
}

export function WizardModal({
  title,
  steps,
  currentStepKey,
  onStepChange,
  onClose,
  dirty = false,
  onFinish,
  finishLabel,
  finishBusy = false,
  finishDisabled = false,
  notice,
  aside,
}: WizardModalProps) {
  /**
   * Set by a finish attempt that had something hidden left to fix. Once the
   * operator has asked to save, every step's problems are theirs to see, and
   * they stay on screen: a reveal that expired would put the modal back to
   * refusing a save it will not explain.
   */
  const [finishAttempted, setFinishAttempted] = useState(false);

  /** Every problem there is: the finish gate and the jump both run on this. */
  const states: WizardStepState[] = steps.map((s) => ({
    key: s.key,
    label: s.label,
    errors: s.errors ?? [],
  }));

  /** The problems the operator has been TOLD about. See `WizardStep.pristine`. */
  const shownErrors = (s: WizardStep): readonly string[] =>
    finishAttempted || !s.pristine ? (s.errors ?? []) : [];
  const shown: WizardStepState[] = steps.map((s) => ({
    key: s.key,
    label: s.label,
    errors: shownErrors(s),
  }));

  // The index the operator was standing on last commit, so a step that
  // disappears hands over to whatever now occupies its place rather than
  // bouncing them to step 1.
  const priorIndexRef = useRef(0);
  const activeKey = resolveStepKey(states, currentStepKey, priorIndexRef.current);
  const position = stepPosition(states, activeKey ?? '');
  useEffect(() => {
    if (position.index !== -1) priorIndexRef.current = position.index;
  });

  const active = steps.find((s) => s.key === activeKey) ?? null;
  const activeErrors = active === null ? [] : shownErrors(active);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const railRef = useRef<HTMLOListElement>(null);
  // Skips the mount run: on open, `Dialog` focuses its panel, which is the right
  // first landing. Only a step CHANGE pulls focus into the heading.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    headingRef.current?.focus();
    // Narrow layouts scroll the rail; the current pill must not be the one off
    // the end. `scrollIntoView` is not implemented in jsdom, hence the guard.
    railRef.current
      ?.querySelector('[aria-current="step"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [activeKey]);

  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  /** The ONE exit. Cancel, the close X, Escape and the backdrop all arrive here. */
  function requestClose() {
    if (finishBusy) return;
    if (dirty) {
      setConfirmingDiscard(true);
      return;
    }
    onClose();
  }

  const outstanding = errorTotal(states);
  /** What the counter beside the finish button may claim: only what has been said. */
  const remaining = errorTotal(shown);
  /** Problems the operator has not been told about yet. Zero once revealed. */
  const unspoken = outstanding - remaining;
  const back = activeKey === null ? null : prevStepKey(states, activeKey);
  const forward = activeKey === null ? null : nextStepKey(states, activeKey);
  const onLastStep = forward === null;

  /** The counter's jump. Targets a problem the operator can actually READ. */
  function jumpToFirstProblem() {
    const target = firstStepWithErrors(shown);
    if (target !== null) onStepChange(target);
  }

  /**
   * The finish attempt. While something is still unspoken the button is live,
   * because a disabled control with no stated reason is the other way to strand
   * an operator: pressing it is what earns the explanation. The press then
   * reveals every step's problems and lands on the earliest, and never commits.
   *
   * Once everything is on screen this is the plain gate it always was, and
   * `disabled` below stops the click before it arrives.
   */
  function handleFinish() {
    if (unspoken > 0) {
      setFinishAttempted(true);
      const target = firstStepWithErrors(states);
      if (target !== null) onStepChange(target);
      return;
    }
    onFinish();
  }

  return (
    <Dialog title={title} onClose={requestClose} variant="wizard" footer={
      confirmingDiscard ? (
        /* Inline, NOT a nested <Dialog>: two mounted dialogs each install a
           document-level keydown trap and fight over Tab and Escape. */
        <div className="wiz__discard" role="alertdialog" aria-label="Discard unsaved changes?">
          <p className="wiz__discard-text">
            You have unsaved changes. Closing now throws them away.
          </p>
          <div className="wiz__discard-actions">
            <GhostButton label="Keep editing" onClick={() => setConfirmingDiscard(false)} />
            {/* `PrimaryButton` has no destructive flag (Compose has no
                DangerButton), so the colour comes from a class rather than an
                invented fourth button component. */}
            <PrimaryButton label="Discard changes" onClick={onClose} className="wiz__discard-go" />
          </div>
        </div>
      ) : (
        <div className="wiz__foot">
          <GhostButton label="Cancel" onClick={requestClose} disabled={finishBusy} />
          <div className="wiz__foot-move">
            {remaining > 0 && (
              <button type="button" className="wiz__remaining" onClick={jumpToFirstProblem}>
                {remaining === 1 ? '1 thing left to fix' : `${remaining} things left to fix`}
              </button>
            )}
            {back !== null && (
              <GhostButton label="Back" onClick={() => onStepChange(back)} disabled={finishBusy} />
            )}
            {forward !== null && (
              <PrimaryButton label="Next" onClick={() => onStepChange(forward)} disabled={finishBusy} />
            )}
            {onLastStep && (
              <PrimaryButton
                label={finishLabel}
                onClick={handleFinish}
                disabled={(outstanding > 0 && unspoken === 0) || finishDisabled || finishBusy}
                busy={finishBusy}
              />
            )}
          </div>
        </div>
      )
    }>
      {notice ? <div className="wiz__notice">{notice}</div> : null}

      <p className="wiz__position">
        Step {position.number} of {position.total}
      </p>

      <nav className="wiz__rail" aria-label={`${title} steps`}>
        {/* `shown`, not `states`: a flag on a step nobody has been to yet is the
            pre-emptive telling-off `pristine` exists to stop. */}
        <ol className="wiz__rail-list" ref={railRef}>
          {shown.map((s, i) => {
            const isCurrent = s.key === activeKey;
            const count = s.errors.length;
            return (
              <li key={s.key} className="wiz__rail-item">
                <button
                  type="button"
                  className={`wiz__rail-step${isCurrent ? ' wiz__rail-step--current' : ''}${
                    count > 0 ? ' wiz__rail-step--flagged' : ''
                  }`}
                  aria-current={isCurrent ? 'step' : undefined}
                  onClick={() => onStepChange(s.key)}
                >
                  {/* The literal spaces are load-bearing: these are inline
                      spans, so without them the accessible name computes as
                      "1Schema" and a screen reader says exactly that. A
                      whitespace-only text node between flex items is not itself
                      an item, so nothing moves on screen. */}
                  <span className="wiz__rail-num">{i + 1}</span>{' '}
                  <span className="wiz__rail-label">{s.label}</span>
                  {count > 0 && (
                    <>
                      {/* The visible marker; the sentence beside it is what a
                          screen reader (and every test here) reads instead. */}
                      <span className="wiz__rail-flag" aria-hidden="true">
                        !
                      </span>{' '}
                      <span className="wiz__sr">
                        {count === 1 ? '1 thing to fix' : `${count} things to fix`}
                      </span>
                    </>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <div className={aside ? 'wiz__cols wiz__cols--aside' : 'wiz__cols'}>
        {active === null ? null : (
          <section className="wiz__step" aria-labelledby="wiz-step-heading">
            <h3 id="wiz-step-heading" className="wiz__step-heading" tabIndex={-1} ref={headingRef}>
              {active.heading ?? active.label}
            </h3>
            {active.blurb && <p className="wiz__step-blurb">{active.blurb}</p>}

            {activeErrors.length > 0 && (
              <Banner tone="warning" title="Fix on this step">
                <ul className="wiz__step-errors">
                  {activeErrors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </Banner>
            )}

            {active.body}
          </section>
        )}

        {aside ? <div className="wiz__aside">{aside}</div> : null}
      </div>
    </Dialog>
  );
}
