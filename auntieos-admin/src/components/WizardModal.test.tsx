// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WizardModal, type WizardStep } from './WizardModal';

/**
 * NOTHING HERE ASSERTS `toBeVisible()` ON A STEP. jsdom ships no user-agent
 * stylesheet, so `toBeVisible` passes on content a real browser hides, and four
 * tests elsewhere in this repo were silently proving nothing for exactly that
 * reason. A step that is not current is asserted by its ABSENCE FROM THE DOM
 * (the modal renders one step body, not all of them behind CSS) and by
 * `aria-current="step"` on the rail, which is a real state carrier a screen
 * reader reads too.
 */

function threeSteps(over: Partial<Record<string, string[]>> = {}): WizardStep[] {
  return [
    {
      key: 'schema',
      label: 'Schema',
      errors: over['schema'] ?? [],
      body: <input aria-label="Name" defaultValue="" />,
    },
    {
      key: 'fields',
      label: 'Fields',
      errors: over['fields'] ?? [],
      body: <input aria-label="Label" defaultValue="" />,
    },
    {
      key: 'review',
      label: 'Review',
      errors: over['review'] ?? [],
      body: <p>Everything looks right.</p>,
    },
  ];
}

/** Drives the controlled `currentStepKey` the way a real caller does. */
function Harness(props: {
  steps?: WizardStep[];
  dirty?: boolean;
  onClose?: () => void;
  onFinish?: () => void;
  initial?: string;
}) {
  const [step, setStep] = useState(props.initial ?? 'schema');
  return (
    <WizardModal
      title="Edit Form Schema"
      steps={props.steps ?? threeSteps()}
      currentStepKey={step}
      onStepChange={setStep}
      onClose={props.onClose ?? (() => {})}
      onFinish={props.onFinish ?? (() => {})}
      finishLabel="Save schema"
      dirty={props.dirty ?? false}
    />
  );
}

describe('WizardModal: the modal itself', () => {
  it('is the shared labelled modal, so it inherits the focus trap and restore', () => {
    render(<Harness />);
    const dlg = screen.getByRole('dialog');
    expect(dlg).toHaveAttribute('aria-modal', 'true');
    expect(dlg).toHaveAccessibleName('Edit Form Schema');
  });
});

describe('WizardModal: the rail', () => {
  it('is real navigation with an accessible name', () => {
    render(<Harness />);
    expect(screen.getByRole('navigation', { name: 'Edit Form Schema steps' })).toBeTruthy();
  });

  it('marks the current step with aria-current and no other step', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: /^1 Schema/ })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: /^2 Fields/ })).not.toHaveAttribute('aria-current');
  });

  it('renders only the current step body, so the others are absent from the DOM', () => {
    render(<Harness />);
    expect(screen.getByLabelText('Name')).toBeTruthy();
    expect(screen.queryByLabelText('Label')).toBeNull();
    expect(screen.queryByText('Everything looks right.')).toBeNull();
  });

  it('jumps straight to any step, not only forward and back', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: /^3 Review/ }));
    expect(screen.getByText('Everything looks right.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^3 Review/ })).toHaveAttribute('aria-current', 'step');
    // And back to the first, without walking through step 2.
    await userEvent.click(screen.getByRole('button', { name: /^1 Schema/ }));
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });

  it('says where you are and how far is left, which is all a phone rail can show', () => {
    render(<Harness initial="fields" />);
    expect(screen.getByText('Step 2 of 3')).toBeTruthy();
  });
});

describe('WizardModal: validation belongs to the step that owns the field', () => {
  it('names a step with problems from the rail, in its accessible name', () => {
    render(<Harness steps={threeSteps({ fields: ['Label is required.'] })} />);
    const flagged = screen.getByRole('button', { name: /^2 Fields/ });
    expect(flagged).toHaveAccessibleName('2 Fields 1 thing to fix');
    expect(screen.getByRole('button', { name: /^1 Schema/ })).toHaveAccessibleName('1 Schema');
  });

  it('pluralises the count so two problems do not read as one', () => {
    render(<Harness steps={threeSteps({ fields: ['a', 'b'] })} />);
    expect(screen.getByRole('button', { name: /^2 Fields/ })).toHaveAccessibleName('2 Fields 2 things to fix');
  });

  it("lists a step's own problems on that step, not on a global banner", async () => {
    render(<Harness steps={threeSteps({ fields: ['Label is required.'] })} />);
    expect(screen.queryByText('Label is required.')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^2 Fields/ }));
    expect(screen.getByText('Label is required.')).toBeTruthy();
  });

  it('disables finish while anything anywhere is unfixed, and says how much', async () => {
    render(<Harness steps={threeSteps({ schema: ['Schema id is required.'] })} initial="review" />);
    const finish = screen.getByRole('button', { name: 'Save schema' });
    expect(finish).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /1 thing to fix/ }));
    expect(screen.getByText('Schema id is required.')).toBeTruthy();
  });

  it('enables finish and calls it once every step is clean', async () => {
    const onFinish = vi.fn();
    render(<Harness onFinish={onFinish} initial="review" />);
    await userEvent.click(screen.getByRole('button', { name: 'Save schema' }));
    expect(onFinish).toHaveBeenCalledOnce();
  });
});

describe('WizardModal: flow-level notices', () => {
  it('shows a notice above the rail, on every step, because it belongs to the flow not a step', async () => {
    function WithNotice() {
      const [step, setStep] = useState('schema');
      return (
        <WizardModal
          title="Edit Form Schema"
          steps={threeSteps()}
          currentStepKey={step}
          onStepChange={setStep}
          onClose={() => {}}
          onFinish={() => {}}
          finishLabel="Save schema"
          notice={<p>saveFormSchema failed: nope</p>}
        />
      );
    }
    render(<WithNotice />);
    expect(screen.getByText('saveFormSchema failed: nope')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /^3 Review/ }));
    expect(screen.getByText('saveFormSchema failed: nope')).toBeTruthy();
  });
});

describe('WizardModal: the persistent aside', () => {
  it('stays beside the body on every step, because it is context and not a step', async () => {
    function WithAside() {
      const [step, setStep] = useState('schema');
      return (
        <WizardModal
          title="Edit Form Schema"
          steps={threeSteps()}
          currentStepKey={step}
          onStepChange={setStep}
          onClose={() => {}}
          onFinish={() => {}}
          finishLabel="Save schema"
          aside={<section aria-label="Live preview">preview</section>}
        />
      );
    }
    render(<WithAside />);
    expect(screen.getByRole('region', { name: 'Live preview' })).toBeTruthy();
    // It is NOT a fourth step: the rail still offers exactly three.
    expect(
      screen.getByRole('navigation', { name: 'Edit Form Schema steps' }).querySelectorAll('button'),
    ).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: /^2 Fields/ }));
    expect(screen.getByRole('region', { name: 'Live preview' })).toBeTruthy();
  });

  it('is absent, not empty, when the caller passes none', () => {
    render(<Harness />);
    expect(document.querySelector('.wiz__aside')).toBeNull();
  });
});

describe('WizardModal: moving between steps', () => {
  it('moves focus to the new step heading, so a keyboard operator lands in the content', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: /^2 Fields/ }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Fields', level: 3 }));
  });

  it('offers Back and Next only where they lead somewhere', async () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { name: 'Fields', level: 3 })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'Fields', level: 3 })).toBeTruthy();
  });

  /**
   * The KinTale case, and the reason `steps` is data rather than a registration:
   * a caller whose sections switch on and off just passes a shorter array.
   */
  it('lands on the step that took its place when the current step disappears', () => {
    const { rerender } = render(<Harness initial="fields" />);
    expect(screen.getByRole('heading', { name: 'Fields', level: 3 })).toBeTruthy();
    const shrunk = threeSteps().filter((s) => s.key !== 'fields');
    rerender(<Harness initial="fields" steps={shrunk} />);
    expect(screen.getByRole('heading', { name: 'Review', level: 3 })).toBeTruthy();
  });
});

describe('WizardModal: nothing is lost', () => {
  it('closes straight away when there is no unsaved work', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('warns before discarding unsaved work rather than closing', async () => {
    const onClose = vi.fn();
    render(<Harness dirty onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/unsaved changes/i)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps editing, on the same step, when the warning is declined', async () => {
    const onClose = vi.fn();
    render(<Harness dirty onClose={onClose} initial="fields" />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Fields', level: 3 })).toBeTruthy();
  });

  it('routes Escape through the same warning, so no exit skips the guard', async () => {
    const onClose = vi.fn();
    render(<Harness dirty onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/unsaved changes/i)).toBeTruthy();
  });

  it('routes the close X through the same warning', async () => {
    const onClose = vi.fn();
    render(<Harness dirty onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/unsaved changes/i)).toBeTruthy();
  });
});
