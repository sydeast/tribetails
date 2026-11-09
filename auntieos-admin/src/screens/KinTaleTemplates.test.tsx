// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import {
  makeChecklistItem,
  makeMoodOption,
  type FieldCondition,
  type KinTaleTemplate,
} from '../lib/kinTale/model';
import {
  CHECKLIST_ITEM_BLANK,
  CHECKLIST_LIMIT_REACHED,
  TEMPLATE_SAVE_REFUSED,
} from '../lib/kinTaleTemplateEdit';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));
// #1707: template writes are owner-only. Every test runs as the owner unless
// it says otherwise.
const access = vi.hoisted(() => ({ current: { status: 'admin' } as { status: string } | null }));
vi.mock('../lib/access', () => ({ useAdminAccess: () => access.current }));

// The trail's KinTales step is a real route link, and a real `Link` wants a
// RouterProvider no suite in this tree mounts (HouseholdData.test.tsx idiom).
vi.mock('@tanstack/react-router', () => ({
  linkOptions: (o: unknown) => o,
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const { saveKinTaleTemplate } = vi.hoisted(() => ({ saveKinTaleTemplate: vi.fn() }));
vi.mock('../api/kinTaleTemplatesWrite', () => ({ saveKinTaleTemplate }));

const { listChecklistBank, saveChecklistBankItem } = vi.hoisted(() => ({
  listChecklistBank: vi.fn(),
  saveChecklistBankItem: vi.fn(),
}));
vi.mock('../api/checklistBank', () => ({ listChecklistBank, saveChecklistBankItem }));

const { getBusinessSettings } = vi.hoisted(() => ({ getBusinessSettings: vi.fn() }));
vi.mock('../api/settings', () => ({ getBusinessSettings }));

// #1591: archive, restore and delete-for-good. The pure halves stay real.
const { removeKinTaleTemplate, getKinTaleTemplateUsage } = vi.hoisted(() => ({
  removeKinTaleTemplate: vi.fn(),
  getKinTaleTemplateUsage: vi.fn(),
}));
vi.mock('../api/kinTaleTemplateRemoval', async (orig) => ({
  ...(await orig<typeof import('../api/kinTaleTemplateRemoval')>()),
  removeKinTaleTemplate,
  getKinTaleTemplateUsage,
}));

import { KinTaleTemplates } from './KinTaleTemplates';

/** The catalog the Service types checkboxes draw from: the real KinCare types (#373). */
const KINCARE_TYPES = { 'Dog Walk': '25', 'Drop-in': '15' };

/** A minimal, valid template doc (raw shape, as it arrives from useCollection). */
function tpl(over: Partial<KinTaleTemplate> = {}): KinTaleTemplate {
  return {
    _id: 't1',
    name: 'Walk recap',
    description: '',
    defaultEmailMessage: 'Had a great time!',
    serviceTypeKeys: ['Dog Walk'],
    isActive: true,
    isDefault: true,
    photoShowcaseEnabled: true,
    checklistEnabled: true,
    petMoodEnabled: false,
    visitNotesEnabled: true,
    nextAppointmentEnabled: true,
    reviewBoosterEnabled: false,
    checklistItems: [makeChecklistItem({ key: 'meds', text: 'Meds', scope: 'PER_PET', order: 0 })],
    moodOptions: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

function mockStream(state: Async<KinTaleTemplate[]>) {
  useCollection.mockImplementation(() => state);
}

const user = userEvent.setup();

beforeEach(() => {
  useCollection.mockReset();
  saveKinTaleTemplate.mockReset().mockResolvedValue('t1');
  listChecklistBank.mockReset().mockResolvedValue([
    { id: 'fresh-water', text: 'Fresh water provided', scope: 'PER_PET' },
    { id: 'home-secured', text: 'Home secured on departure', scope: 'PER_VISIT' },
  ]);
  saveChecklistBankItem.mockReset().mockResolvedValue({ id: 'meds', text: 'Meds', scope: 'PER_PET' });
  getBusinessSettings.mockReset().mockResolvedValue({ serviceRates: KINCARE_TYPES, serviceDurations: {} });
  removeKinTaleTemplate.mockReset().mockResolvedValue(undefined);
  getKinTaleTemplateUsage.mockReset();
  mockStream({ status: 'ready', data: [tpl()] });
  access.current = { status: 'admin' };
});
describe('KinTaleTemplates: owner-only writes (#1707)', () => {
  const live = tpl();
  const archived = tpl({ _id: 't2', name: 'Old recap', isDefault: false, archived: true });
  it.each([
    ['an Auntie', { status: 'caretaker' }],
    ['a test admin', { status: 'testAdmin', testTribeId: 'tribe-x' }],
  ])('offers %s no New template, Remove, Restore, Delete for good or editor', async (_who, a) => {
    access.current = a;
    mockStream({ status: 'ready', data: [live, archived] });
    render(<KinTaleTemplates />);
    // The templates are still listed, read-only.
    expect(await screen.findByText('Walk recap')).toBeInTheDocument();
    expect(screen.getByText('Old recap')).toBeInTheDocument();
    expect(screen.getByText('Only the owner can change KinTale templates.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new template/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^remove/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^restore/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /for good/i })).toBeNull();
    // The row is not a button, so no editor (whose only exit is Save template) opens.
    expect(screen.queryByRole('button', { name: /^walk recap/i })).toBeNull();
    await user.click(screen.getByText('Walk recap'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('offers nothing while access is still resolving, and no owner-only line either', async () => {
    access.current = null;
    mockStream({ status: 'ready', data: [live] });
    render(<KinTaleTemplates />);
    expect(await screen.findByText('Walk recap')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new template/i })).toBeNull();
    expect(screen.queryByText('Only the owner can change KinTale templates.')).toBeNull();
  });
  it('still offers the owner every control', async () => {
    mockStream({ status: 'ready', data: [live, archived] });
    render(<KinTaleTemplates />);
    expect(await screen.findByRole('button', { name: /new template/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Walk recap' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore Old recap' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Old recap for good' })).toBeInTheDocument();
    expect(screen.queryByText('Only the owner can change KinTale templates.')).toBeNull();
  });
});

/**
 * The editor is a workflow modal now, so every test that edits has to open it
 * first, walk to the step that owns the field, and reach Finish from the last
 * step. These three helpers are that preamble, named once.
 */

/** Opens a saved template from the picker. The picker stays on screen behind it. */
async function openEditor(name: RegExp = /^walk recap/i): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name }));
  return await screen.findByRole('dialog');
}

/** Opens a blank draft from the picker's "New template" action. */
async function openNewTemplate(): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: /new template/i }));
  return await screen.findByRole('dialog');
}

/** Rail navigation, by the step's visible label (the rail numbers it). */
async function goToStep(label: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: new RegExp(`^\\d+ ${label}`) }));
}

/** The rail, whose accessible name is the modal title suffixed with "steps". */
function rail(): HTMLElement {
  return screen.getByRole('navigation', { name: /steps$/ });
}

/**
 * Finish lives on the LAST step (WizardModal offers "Next" everywhere else), so
 * a save walks to the end of the rail rather than hunting for a button that is
 * not rendered yet.
 */
async function saveTemplate(): Promise<void> {
  const pills = within(rail()).getAllByRole('button');
  await user.click(pills[pills.length - 1]!);
  await user.click(screen.getByRole('button', { name: /^save template$/i }));
}

describe('KinTaleTemplates: the workflow modal', () => {
  it('leaves the picker on screen and opens no editor until a template is picked', async () => {
    render(<KinTaleTemplates />);
    await screen.findByRole('button', { name: /^walk recap/i });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByDisplayValue('Walk recap')).toBeNull();

    await openEditor();
    // The picker did not go away: backing out returns to the row that was clicked.
    expect(screen.getByRole('button', { name: /new template/i })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Walk recap')).toBeInTheDocument();
  });

  it('is a labelled modal with a named rail, opening on the first step', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Edit KinTale template');
    expect(screen.getByRole('navigation', { name: 'Edit KinTale template steps' })).toBeInTheDocument();
    // checklist on, pet mood off in the fixture: basic, sections, per-Kin, per-visit.
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument();
    expect(within(rail()).getAllByRole('button')).toHaveLength(4);
  });

  it('keeps each section on its own step, so the other steps are not in the DOM', async () => {
    render(<KinTaleTemplates />);
    await openEditor();

    // Absence from the DOM plus aria-current, never toBeVisible: jsdom ships no
    // user-agent stylesheet, so a visibility assertion passes on hidden content.
    expect(screen.getByLabelText('Template name')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Photo & video showcase' })).toBeNull();
    expect(screen.getByRole('button', { name: /^1 Basic settings/ })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: /^2 Display sections/ })).not.toHaveAttribute('aria-current');

    await goToStep('Display sections');
    expect(screen.getByRole('switch', { name: 'Photo & video showcase' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Template name')).toBeNull();
    expect(screen.getByRole('button', { name: /^2 Display sections/ })).toHaveAttribute('aria-current', 'step');

    await goToStep('Per-Kin items');
    expect(screen.getByLabelText('Item text')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Photo & video showcase' })).toBeNull();
  });

  it('keeps what was typed when the operator leaves the step and comes back', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    await user.clear(screen.getByLabelText('Template name'));
    await user.type(screen.getByLabelText('Template name'), 'Evening walk');
    await goToStep('Display sections');
    await goToStep('Basic settings');
    expect(screen.getByLabelText('Template name')).toHaveValue('Evening walk');
  });

  it('flags the step that owns the blank name, from the rail', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    expect(screen.getByRole('button', { name: /^1 Basic settings/ })).toHaveAccessibleName('1 Basic settings');

    await user.clear(screen.getByLabelText('Template name'));
    // Readable from the rail, on every step, without walking to find it.
    await goToStep('Per-visit items');
    expect(screen.getByRole('button', { name: /^1 Basic settings/ })).toHaveAccessibleName(
      '1 Basic settings 1 thing to fix',
    );
    expect(screen.getByRole('button', { name: /^save template$/i })).toBeDisabled();
  });

  it('drops the checklist steps when the toggle goes off, and keeps the items anyway', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    await goToStep('Display sections');
    await user.click(screen.getByRole('switch', { name: 'Checklist' }));

    expect(within(rail()).queryByRole('button', { name: /Per-Kin items/ })).toBeNull();
    expect(within(rail()).queryByRole('button', { name: /Per-visit items/ })).toBeNull();
    expect(screen.getByText('Step 2 of 2')).toBeInTheDocument();

    // Turning the section off hides the STEP, it does not delete the work.
    await saveTemplate();
    await waitFor(() => expect(saveKinTaleTemplate).toHaveBeenCalledTimes(1));
    const arg = saveKinTaleTemplate.mock.calls[0]![0] as KinTaleTemplate;
    expect(arg.checklistEnabled).toBe(false);
    expect(arg.checklistItems).toHaveLength(1);
  });

  it('adds the mood step when Kin mood goes on, and hands over positionally when it goes off', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    await goToStep('Display sections');
    await user.click(screen.getByRole('switch', { name: 'Kin mood' }));
    expect(within(rail()).getByRole('button', { name: /^5 Mood options/ })).toBeInTheDocument();

    // Standing on the mood step when it disappears lands on the step that took
    // its index, not back at step 1.
    await goToStep('Mood options');
    expect(screen.getByRole('button', { name: /^5 Mood options/ })).toHaveAttribute('aria-current', 'step');
    await goToStep('Display sections');
    await user.click(screen.getByRole('switch', { name: 'Kin mood' }));
    expect(within(rail()).queryByRole('button', { name: /Mood options/ })).toBeNull();
  });

  it('draws every field of a step in full, never behind a disclosure', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    // Basic settings keeps all six of its controls open at once.
    expect(screen.getByLabelText('Template name')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toBeInTheDocument();
    expect(screen.getByLabelText('Default message to kinfolk')).toBeInTheDocument();
    expect(await screen.findByRole('group', { name: 'Service types' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Make default template' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Active' })).toBeInTheDocument();

    await goToStep('Per-Kin items');
    expect(screen.getByLabelText('Item text')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Required' })).toBeInTheDocument();
    expect(screen.getByText('Conditions')).toBeInTheDocument();

    // Splitting across named steps is the approved answer to this screen's
    // length; folding fields behind a disclosure was ruled out on 2026-08-08.
    expect(document.querySelector('details')).toBeNull();
  });

  it('warns before discarding typed work, and closes only when the operator says so', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    await user.type(screen.getByLabelText('Template name'), ' v2');
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /keep editing/i }));
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    await user.click(screen.getByRole('button', { name: /discard changes/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Discarded for real: reopening shows the stored name, not the edited one.
    await openEditor();
    expect(screen.getByLabelText('Template name')).toHaveValue('Walk recap');
  });

  it('opens a new template clean, so backing straight out asks nothing', async () => {
    render(<KinTaleTemplates />);
    await screen.findByRole('button', { name: /^walk recap/i });
    await openNewTemplate();
    expect(screen.getByLabelText('Template name')).toHaveValue('New template');
    // Mark 23 of the 2026-08-17 walk: no canned default message on a fresh draft.
    expect(screen.getByLabelText('Default message to kinfolk')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes on a successful save and says so on the screen behind', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    await saveTemplate();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText(/template saved/i)).toBeInTheDocument();
  });
});

describe('KinTaleTemplates: load + picker', () => {
  it('opens the picked template into the editor', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    expect(screen.getByDisplayValue('Walk recap')).toBeInTheDocument();
    // Service types round-trip into the catalog checkboxes, on the same first step.
    expect(await screen.findByRole('checkbox', { name: 'Dog Walk' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Drop-in' })).not.toBeChecked();
  });

  it('heads the screen with the mock trail, KinTales / Templates, in place of a kicker', () => {
    mockStream({ status: 'ready', data: [] });
    render(<KinTaleTemplates />);
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('link', { name: 'KinTales' })).toHaveAttribute('href', '/kintales');
    expect(within(nav).getByText('Templates')).toHaveAttribute('aria-current', 'page');
    expect(document.querySelector('.den-heading-kicker')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('KinTale templates.');
  });

  it('tags the rows with the kit pill: Default in orange, Inactive muted, both compact', () => {
    mockStream({
      status: 'ready',
      data: [
        tpl({ _id: 't1', name: 'Walk recap', isDefault: true }),
        tpl({ _id: 't2', name: 'Sit recap', isDefault: false, isActive: false }),
      ],
    });
    render(<KinTaleTemplates />);
    const def = screen.getByText('Default');
    expect(def).toHaveClass('den-statuspill', 'den-statuspill--compact');
    expect(def).toHaveAttribute('data-tone', 'orange');
    const inactive = screen.getByText('Inactive');
    expect(inactive).toHaveClass('den-statuspill', 'den-statuspill--compact');
    expect(inactive).toHaveAttribute('data-tone', 'muted');
    expect(document.querySelector('.ktt__tag')).toBeNull();
  });

  it('lists templates with a Default tag and switches when another is picked', async () => {
    mockStream({
      status: 'ready',
      data: [tpl({ _id: 't1', name: 'Walk recap', isDefault: true }), tpl({ _id: 't2', name: 'Sit recap', isDefault: false })],
    });
    render(<KinTaleTemplates />);
    await openEditor();
    expect(screen.getByDisplayValue('Walk recap')).toBeInTheDocument();

    // Nothing typed, so backing out is immediate; the picker was behind the
    // modal the whole time, and the other row is still there to pick.
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await openEditor(/^sit recap/i);
    expect(screen.getByDisplayValue('Sit recap')).toBeInTheDocument();
  });

  it('surfaces a listener error, never a false empty', async () => {
    mockStream({ status: 'error', message: 'permission-denied' });
    render(<KinTaleTemplates />);
    expect(await screen.findByText('permission-denied', { selector: '.async-error-detail' })).toBeInTheDocument();
  });
});

describe('KinTaleTemplates: create-from-default', () => {
  it('seeds the built-in default when no templates exist yet', async () => {
    mockStream({ status: 'ready', data: [] });
    render(<KinTaleTemplates />);
    expect(await screen.findByText(/no templates saved yet/i)).toBeInTheDocument();
    // The create-from-default path the always-visible editor used to pre-seed.
    // The built-in default is Android's `DefaultKinTaleTemplate` ("Standard
    // Visit"); `lib/kinTale/model.ts` records why Android is the reference and
    // not the Compose desktop.
    await openNewTemplate();
    expect(screen.getByDisplayValue('Standard Visit')).toBeInTheDocument();
    // Even this seed carries no canned message: the built-in default's own
    // `defaultEmailMessage` is blank (mark 23 of the 2026-08-17 walk).
    expect(screen.getByLabelText('Default message to kinfolk')).toHaveValue('');
  });

  it('New template starts a fresh, non-default draft', async () => {
    render(<KinTaleTemplates />);
    await screen.findByRole('button', { name: /^walk recap/i });
    await openNewTemplate();
    expect(screen.getByDisplayValue('New template')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Make default template' })).not.toBeChecked();
  });
});

describe('KinTaleTemplates: Service types are a catalog, not a text box', () => {
  it('offers exactly the configured KinCare types, none more and none missing', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    const group = await screen.findByRole('group', { name: 'Service types' });
    expect(within(group).getAllByRole('checkbox')).toHaveLength(Object.keys(KINCARE_TYPES).length);
    expect(within(group).getByRole('checkbox', { name: 'Dog Walk' })).toBeInTheDocument();
    expect(within(group).getByRole('checkbox', { name: 'Drop-in' })).toBeInTheDocument();
  });

  it('a stored key the catalog no longer has is kept, checked, flagged, and survives an untouched save', async () => {
    mockStream({ status: 'ready', data: [tpl({ serviceTypeKeys: ['Dog Walk', 'Retired Visit'] })] });
    render(<KinTaleTemplates />);
    await openEditor();
    const stale = await screen.findByRole('checkbox', { name: /Retired Visit/ });
    expect(stale).toBeChecked();
    expect(screen.getByText('not in your current KinCare types')).toBeInTheDocument();

    await saveTemplate();
    await waitFor(() => expect(saveKinTaleTemplate).toHaveBeenCalledTimes(1));
    const arg = saveKinTaleTemplate.mock.calls[0]![0] as KinTaleTemplate;
    expect(arg.serviceTypeKeys).toEqual(['Dog Walk', 'Retired Visit']);
  });

  it('#994: saving an existing template hands over the row it opened with, as the diff baseline', async () => {
    const stored = tpl({ serviceTypeKeys: ['Dog Walk', 'Retired Visit'] });
    mockStream({ status: 'ready', data: [stored] });
    render(<KinTaleTemplates />);
    await openEditor();
    await user.click(await screen.findByRole('checkbox', { name: /Retired Visit/ }));

    await saveTemplate();
    await waitFor(() => expect(saveKinTaleTemplate).toHaveBeenCalledTimes(1));
    // The decoded row: the stored doc plus the #1591 archive fields at their defaults.
    expect(saveKinTaleTemplate.mock.calls[0]![2]).toEqual({ ...stored, archived: false, archivedAt: '' });
  });

  it('unticking a stale key removes only that key', async () => {
    mockStream({ status: 'ready', data: [tpl({ serviceTypeKeys: ['Dog Walk', 'Retired Visit'] })] });
    render(<KinTaleTemplates />);
    await openEditor();
    await user.click(await screen.findByRole('checkbox', { name: /Retired Visit/ }));

    await saveTemplate();
    await waitFor(() => expect(saveKinTaleTemplate).toHaveBeenCalledTimes(1));
    const arg = saveKinTaleTemplate.mock.calls[0]![0] as KinTaleTemplate;
    expect(arg.serviceTypeKeys).toEqual(['Dog Walk']);
  });

  it('a failed catalog load still shows the stored keys, editable, with no text box offered', async () => {
    getBusinessSettings.mockReset().mockRejectedValue(new Error('permission-denied'));
    render(<KinTaleTemplates />);
    await openEditor();
    expect(await screen.findByText(/couldn.t load your kincare types/i)).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: /Dog Walk/ })).toBeChecked();
    // No free-text fallback: the field never grows a text input, catalog error or not.
    expect(screen.queryByPlaceholderText(/comma separated/i)).toBeNull();
  });
});

describe('KinTaleTemplates: checklist condition editor (the I7 payload)', () => {
  it('adds a KINFOLK_ATTRIBUTE / EXISTS condition: attribute dropdown shows, value input hides', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    await goToStep('Per-Kin items');

    await user.click(screen.getByRole('button', { name: /add condition/i }));

    // Default new condition is KIN_SPECIES / EQUALS: value shown, no attribute dropdown.
    expect(screen.getByLabelText('Value')).toBeInTheDocument();
    expect(screen.queryByLabelText('Attribute')).toBeNull();

    // Switch to a household attribute: attribute dropdown appears, defaulted to the first key.
    await user.selectOptions(screen.getByLabelText('When'), 'KINFOLK_ATTRIBUTE');
    const attr = await screen.findByLabelText('Attribute');
    expect(attr).toHaveValue('serviceAddress');

    // EXISTS needs no value: the value input disappears.
    await user.selectOptions(screen.getByLabelText('Is'), 'EXISTS');
    expect(screen.queryByLabelText('Value')).toBeNull();

    // The live summary reflects the household attribute.
    expect(screen.getByText(/only show when the household's/i)).toBeInTheDocument();

    await saveTemplate();
    await waitFor(() => expect(saveKinTaleTemplate).toHaveBeenCalledTimes(1));
    const arg = saveKinTaleTemplate.mock.calls[0]![0] as KinTaleTemplate;
    expect(arg.checklistItems[0]!.conditions[0]).toEqual<FieldCondition>({
      source: 'KINFOLK_ATTRIBUTE',
      op: 'EXISTS',
      value: '',
      attributeKey: 'serviceAddress',
    });
  });

  it('a SERVICE_TYPE condition value offers the real KinCare types as suggestions, not a hard constraint', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    await goToStep('Per-Kin items');
    await user.click(screen.getByRole('button', { name: /add condition/i }));
    await user.selectOptions(screen.getByLabelText('When'), 'SERVICE_TYPE');

    const value = await screen.findByLabelText('Value');
    const listId = value.getAttribute('list');
    expect(listId).toBeTruthy();
    const datalist = document.getElementById(listId!);
    expect(datalist?.tagName.toLowerCase()).toBe('datalist');
    const optionValues = Array.from(datalist!.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(optionValues).toEqual(['Dog Walk', 'Drop-in']);

    // Still free text: CONTAINS needs a substring, and a legacy session may
    // carry a retired service-type name, so typing something off-catalog works.
    await user.type(value, 'evening walk');
    expect(value).toHaveValue('evening walk');
  });

  it('adds a KINFOLK_TAG / CONTAINS condition: no attribute dropdown, value carries the tag', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    await goToStep('Per-Kin items');

    await user.click(screen.getByRole('button', { name: /add condition/i }));
    await user.selectOptions(screen.getByLabelText('When'), 'KINFOLK_TAG');
    // Tag source is not attribute-backed.
    expect(screen.queryByLabelText('Attribute')).toBeNull();

    await user.selectOptions(screen.getByLabelText('Is'), 'CONTAINS');
    await user.type(screen.getByLabelText('Value'), 'VIP');

    await saveTemplate();
    await waitFor(() => expect(saveKinTaleTemplate).toHaveBeenCalledTimes(1));
    const arg = saveKinTaleTemplate.mock.calls[0]![0] as KinTaleTemplate;
    expect(arg.checklistItems[0]!.conditions[0]).toEqual<FieldCondition>({
      source: 'KINFOLK_TAG',
      op: 'CONTAINS',
      value: 'VIP',
      attributeKey: '',
    });
  });

  it('removing a condition drops it from the saved payload', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    await goToStep('Per-Kin items');
    await user.click(screen.getByRole('button', { name: /add condition/i }));
    await user.click(screen.getByRole('button', { name: /remove condition/i }));

    await saveTemplate();
    await waitFor(() => expect(saveKinTaleTemplate).toHaveBeenCalledTimes(1));
    const arg = saveKinTaleTemplate.mock.calls[0]![0] as KinTaleTemplate;
    expect(arg.checklistItems[0]!.conditions).toEqual([]);
  });
});

describe('KinTaleTemplates: editing the sections + items round-trips into the save', () => {
  it('save carries the section toggles, item edits, and the service types', async () => {
    render(<KinTaleTemplates />);
    await openEditor();

    // Toggle a display section on, on the step that owns the toggles.
    await goToStep('Display sections');
    await user.click(screen.getByRole('switch', { name: 'Review booster' }));
    // Edit the one checklist item's text + required, on the step that owns it.
    await goToStep('Per-Kin items');
    await user.clear(screen.getByLabelText('Item text'));
    await user.type(screen.getByLabelText('Item text'), 'Medications given');
    await user.click(screen.getByRole('switch', { name: 'Required' }));

    await saveTemplate();
    await waitFor(() => expect(saveKinTaleTemplate).toHaveBeenCalledTimes(1));
    const arg = saveKinTaleTemplate.mock.calls[0]![0] as KinTaleTemplate;
    expect(arg.reviewBoosterEnabled).toBe(true);
    expect(arg.serviceTypeKeys).toEqual(['Dog Walk']);
    expect(arg.checklistItems[0]).toMatchObject({ text: 'Medications given', required: true, scope: 'PER_PET' });
  });

  it('adding a per-visit item appends it in the per-visit scope', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    // No scoping needed any more: only the step being edited is in the DOM, so
    // "Add per-visit item" cannot collide with the per-Kin section's action.
    await goToStep('Per-visit items');
    await user.click(screen.getByRole('button', { name: /add per-visit item/i }));
    // #1593: a new item starts blank, and a blank item is never saved.
    await user.type(screen.getByLabelText('Item text'), 'Bins out');

    await saveTemplate();
    await waitFor(() => expect(saveKinTaleTemplate).toHaveBeenCalledTimes(1));
    const arg = saveKinTaleTemplate.mock.calls[0]![0] as KinTaleTemplate;
    expect(arg.checklistItems.filter((i) => i.scope === 'PER_VISIT')).toMatchObject([{ text: 'Bins out' }]);
  });

  it('mood editor (pet mood on) adds a mood that survives the save', async () => {
    mockStream({
      status: 'ready',
      data: [
        tpl({
          petMoodEnabled: true,
          moodOptions: [makeMoodOption({ key: 'happy', label: 'Happy', emoji: '😊', order: 0 })],
        }),
      ],
    });
    render(<KinTaleTemplates />);
    await openEditor();
    await goToStep('Mood options');
    await user.click(screen.getByRole('button', { name: /add mood/i }));

    await saveTemplate();
    await waitFor(() => expect(saveKinTaleTemplate).toHaveBeenCalledTimes(1));
    const arg = saveKinTaleTemplate.mock.calls[0]![0] as KinTaleTemplate;
    expect(arg.moodOptions).toHaveLength(2);
  });
});

/**
 * The shared checklist bank (`listChecklistBank` / `saveChecklistBankItem`, both
 * deployed admin callables) backs a quick-add row under each checklist scope, so
 * the common items are two clicks instead of retyped per template. Ported from
 * the archive's `BankAddRow`.
 */
describe('KinTaleTemplates: checklist bank quick-add', () => {
  /**
   * The quick-add row of the checklist step currently on screen. One step is
   * rendered at a time now, so this needs no panel scoping, but it still has to
   * be a container query rather than a name query: once an item is added, its own
   * row actions ("Move X up", "Remove X") also match a name query for that text,
   * so an unscoped query would find the row it was meant to prove had gone.
   */
  function bankRow(): HTMLElement | null {
    return document.querySelector('.ktt__bank');
  }

  it('offers the bank items for a scope, and only that scope', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    await goToStep('Per-Kin items');
    await waitFor(() => expect(bankRow()).not.toBeNull());

    expect(within(bankRow()!).getByRole('button', { name: /fresh water provided/i })).toBeInTheDocument();
    expect(within(bankRow()!).queryByRole('button', { name: /home secured/i })).toBeNull();

    await goToStep('Per-visit items');
    expect(within(bankRow()!).getByRole('button', { name: /home secured/i })).toBeInTheDocument();
  });

  it('clicking a bank item inserts it as a real checklist row that survives the save', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    await goToStep('Per-Kin items');
    await waitFor(() => expect(bankRow()).not.toBeNull());

    await user.click(within(bankRow()!).getByRole('button', { name: /fresh water provided/i }));

    expect(screen.getByDisplayValue('Fresh water provided')).toBeInTheDocument();

    await saveTemplate();
    await waitFor(() => expect(saveKinTaleTemplate).toHaveBeenCalledTimes(1));
    const arg = saveKinTaleTemplate.mock.calls[0]![0] as KinTaleTemplate;
    const added = arg.checklistItems.find((i) => i.text === 'Fresh water provided');
    expect(added).toMatchObject({ scope: 'PER_PET' });
    // Appended after the existing item, with its own fresh key.
    expect(added!.key).not.toBe('meds');
  });

  it('stops offering an item once it is in the checklist, so it cannot be added twice', async () => {
    // The per-pet bank holds exactly one item in this fixture, so adding it
    // leaves nothing to offer and the whole row goes away rather than sitting
    // there as an empty "Add from bank" heading (the archive's rule).
    render(<KinTaleTemplates />);
    await openEditor();
    await goToStep('Per-Kin items');
    await waitFor(() => expect(bankRow()).not.toBeNull());
    await user.click(within(bankRow()!).getByRole('button', { name: /fresh water provided/i }));
    expect(bankRow()).toBeNull();
    // The per-visit scope is untouched: exhausting one scope never hides another.
    await goToStep('Per-visit items');
    expect(within(bankRow()!).getByRole('button', { name: /home secured/i })).toBeInTheDocument();
  });

  it('saves a hand-written item to the shared bank and reports it inside the wizard', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    await goToStep('Per-Kin items');

    listChecklistBank.mockResolvedValue([
      { id: 'fresh-water', text: 'Fresh water provided', scope: 'PER_PET' },
      { id: 'meds', text: 'Meds', scope: 'PER_PET' },
    ]);
    await user.click(screen.getByRole('button', { name: /save "meds" to the bank/i }));

    await waitFor(() => expect(saveChecklistBankItem).toHaveBeenCalledWith('Meds', 'PER_PET'));
    // Inside the dialog: a banner painted on the screen behind an open modal is
    // one the operator never sees.
    const notice = await screen.findByText(/saved to the bank/i);
    expect(screen.getByRole('dialog')).toContainElement(notice);
  });

  it('names the reason when the bank fails to load, never a silently empty picker', async () => {
    listChecklistBank.mockRejectedValue(new Error('permission-denied'));
    render(<KinTaleTemplates />);
    // Screen-level on purpose: this fires on mount, before any modal is open.
    expect(await screen.findByText(/couldn't load the checklist bank: permission-denied/i)).toBeInTheDocument();
  });

  it('names the reason when saving to the bank rejects', async () => {
    saveChecklistBankItem.mockRejectedValue(new Error('unavailable'));
    render(<KinTaleTemplates />);
    await openEditor();
    await goToStep('Per-Kin items');
    await user.click(screen.getByRole('button', { name: /save "meds" to the bank/i }));
    const notice = await screen.findByText(/couldn't save to the bank: unavailable/i);
    expect(screen.getByRole('dialog')).toContainElement(notice);
  });
});

describe('KinTaleTemplates: default exclusivity', () => {
  it('hands the writer the streamed siblings, so setting default can unset the others', async () => {
    mockStream({
      status: 'ready',
      data: [tpl({ _id: 't1', name: 'Walk recap', isDefault: true }), tpl({ _id: 't2', name: 'Sit recap', isDefault: false })],
    });
    render(<KinTaleTemplates />);
    await openEditor(/^sit recap/i);
    expect(screen.getByDisplayValue('Sit recap')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Make default template' }));

    await saveTemplate();
    await waitFor(() => expect(saveKinTaleTemplate).toHaveBeenCalledTimes(1));
    const [saved, siblings] = saveKinTaleTemplate.mock.calls[0] as [
      KinTaleTemplate,
      ReadonlyArray<{ _id: string; isDefault: boolean }>,
    ];
    expect(saved).toMatchObject({ _id: 't2', isDefault: true });
    expect(siblings).toEqual([
      { _id: 't1', isDefault: true },
      { _id: 't2', isDefault: false },
    ]);
  });

  it('tells the operator the flag moved, rather than leaving the picker to explain it', async () => {
    mockStream({
      status: 'ready',
      data: [tpl({ _id: 't1', name: 'Walk recap', isDefault: true }), tpl({ _id: 't2', name: 'Sit recap', isDefault: false })],
    });
    render(<KinTaleTemplates />);
    await openEditor(/^sit recap/i);
    expect(screen.getByDisplayValue('Sit recap')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Make default template' }));
    expect(screen.getByText(/only one template can be the default/i)).toBeInTheDocument();
  });
});

/**
 * #1593 (QA walk 2026-11-05): "an empty checklist item saves." The field now
 * refuses with a sentence beside it, Save never greys out without one on screen,
 * and the Firestore rules refuse the same thing for any client that skips this.
 */
describe('KinTaleTemplates: checklist items need text, and there are at most 60 (#1593)', () => {
  function sixty() {
    return Array.from({ length: 60 }, (_, i) =>
      makeChecklistItem({ key: `item_${i + 1}`, text: `Item ${i + 1}`, scope: 'PER_PET', order: i }),
    );
  }

  async function lastStep(): Promise<void> {
    const pills = within(rail()).getAllByRole('button');
    await user.click(pills[pills.length - 1]!);
  }

  it('says nothing about a new item until the operator leaves it, then says why beside it', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    await goToStep('Per-Kin items');
    await user.click(screen.getByRole('button', { name: /add per-kin item/i }));

    const fresh = screen.getAllByLabelText('Item text')[1]!;
    expect(screen.queryByText(CHECKLIST_ITEM_BLANK)).toBeNull();
    expect(fresh).not.toHaveAttribute('aria-invalid');
    expect(screen.getByRole('button', { name: /^3 Per-Kin items/ })).toHaveAccessibleName('3 Per-Kin items');

    await user.click(fresh);
    await user.tab();

    expect(screen.getByText(CHECKLIST_ITEM_BLANK)).toBeInTheDocument();
    expect(fresh).toHaveAttribute('aria-invalid', 'true');
    expect(fresh).toHaveAccessibleDescription(CHECKLIST_ITEM_BLANK);
    expect(screen.getByRole('button', { name: /^3 Per-Kin items/ })).toHaveAccessibleName(
      '3 Per-Kin items 1 thing to fix',
    );

    // Save is off now, and the reason is on screen beside it.
    await lastStep();
    expect(screen.getByRole('button', { name: /^save template$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: '1 thing left to fix' })).toBeInTheDocument();
  });

  it('a Save press with an untouched blank item saves nothing and lands on the item, saying why', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    await goToStep('Per-Kin items');
    await user.click(screen.getByRole('button', { name: /add per-kin item/i }));

    await saveTemplate();

    expect(saveKinTaleTemplate).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Per-Kin items', level: 3 })).toBeInTheDocument();
    expect(screen.getByText(CHECKLIST_ITEM_BLANK)).toBeInTheDocument();
    expect(screen.getByText(`Item 2: ${CHECKLIST_ITEM_BLANK}`)).toBeInTheDocument();
    expect(screen.getAllByLabelText('Item text')[1]).toHaveAttribute('aria-invalid', 'true');
  });

  it('spaces alone are blank; typing text clears the message and the save goes through', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    await goToStep('Per-Kin items');
    await user.click(screen.getByRole('button', { name: /add per-kin item/i }));
    const fresh = screen.getAllByLabelText('Item text')[1]!;
    await user.type(fresh, '   ');
    await user.tab();
    expect(screen.getByText(CHECKLIST_ITEM_BLANK)).toBeInTheDocument();

    await user.type(fresh, 'Fed');
    expect(screen.queryByText(CHECKLIST_ITEM_BLANK)).toBeNull();

    await saveTemplate();
    await waitFor(() => expect(saveKinTaleTemplate).toHaveBeenCalledTimes(1));
    const arg = saveKinTaleTemplate.mock.calls[0]![0] as KinTaleTemplate;
    expect(arg.checklistItems.map((i) => i.text.trim())).toEqual(['Meds', 'Fed']);
  });

  it('a template that arrives with a blank item flags it at once and will not save', async () => {
    mockStream({
      status: 'ready',
      data: [
        tpl({
          checklistItems: [
            makeChecklistItem({ key: 'meds', text: 'Meds', scope: 'PER_PET', order: 0 }),
            makeChecklistItem({ key: 'old', text: ' ', scope: 'PER_PET', order: 1 }),
          ],
        }),
      ],
    });
    render(<KinTaleTemplates />);
    await openEditor();
    expect(screen.getByRole('button', { name: /^3 Per-Kin items/ })).toHaveAccessibleName(
      '3 Per-Kin items 1 thing to fix',
    );
    await lastStep();
    const finish = screen.getByRole('button', { name: /^save template$/i });
    expect(finish).toBeDisabled();
    await user.click(finish);
    expect(saveKinTaleTemplate).not.toHaveBeenCalled();
  });

  it('with the checklist switched off, a blank item is still caught, on Display sections', async () => {
    mockStream({
      status: 'ready',
      data: [
        tpl({
          checklistEnabled: false,
          checklistItems: [makeChecklistItem({ key: 'old', text: '', scope: 'PER_VISIT', order: 0 })],
        }),
      ],
    });
    render(<KinTaleTemplates />);
    await openEditor();
    expect(screen.getByRole('button', { name: /^2 Display sections/ })).toHaveAccessibleName(
      '2 Display sections 1 thing to fix',
    );
    await goToStep('Display sections');
    expect(screen.getByText(`Per-visit item 1: ${CHECKLIST_ITEM_BLANK}`)).toBeInTheDocument();
  });

  it('at 60 items Add is off, Add from bank is off, and the sentence beside Add says why', async () => {
    mockStream({ status: 'ready', data: [tpl({ checklistItems: sixty() })] });
    render(<KinTaleTemplates />);
    await openEditor();
    await goToStep('Per-Kin items');
    expect(screen.getByRole('button', { name: /add per-kin item/i })).toBeDisabled();
    expect(screen.getByText(CHECKLIST_LIMIT_REACHED)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /fresh water provided/i })).toBeDisabled();

    // The cap is on the whole checklist, so the other scope is full too.
    await goToStep('Per-visit items');
    expect(screen.getByRole('button', { name: /add per-visit item/i })).toBeDisabled();
    expect(screen.getByText(CHECKLIST_LIMIT_REACHED)).toBeInTheDocument();

    // 60 is allowed: the template still saves.
    await saveTemplate();
    await waitFor(() => expect(saveKinTaleTemplate).toHaveBeenCalledTimes(1));
  });

  it('a stored checklist over 60 will not save, and says why', async () => {
    const over = [
      ...sixty(),
      makeChecklistItem({ key: 'item_61', text: 'Item 61', scope: 'PER_PET', order: 60 }),
    ];
    mockStream({ status: 'ready', data: [tpl({ checklistItems: over })] });
    render(<KinTaleTemplates />);
    await openEditor();
    await goToStep('Per-Kin items');
    expect(screen.getAllByText(CHECKLIST_LIMIT_REACHED).length).toBeGreaterThan(0);
    await lastStep();
    expect(screen.getByRole('button', { name: /^save template$/i })).toBeDisabled();
  });

  it('a rules refusal says what the rule checks, never the raw code', async () => {
    saveKinTaleTemplate.mockRejectedValue(
      Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }),
    );
    render(<KinTaleTemplates />);
    await openEditor();
    await saveTemplate();
    expect(await screen.findByText(TEMPLATE_SAVE_REFUSED)).toBeInTheDocument();
    expect(screen.queryByText(/insufficient permissions/i)).toBeNull();
  });
});

describe('KinTaleTemplates: save, fail-loud', () => {
  it('shows a success banner after a save', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    await saveTemplate();
    expect(await screen.findByText(/template saved/i)).toBeInTheDocument();
  });

  it('names the reason when the save rejects, never a fake success', async () => {
    saveKinTaleTemplate.mockRejectedValue(new Error('offline'));
    render(<KinTaleTemplates />);
    await openEditor();
    await saveTemplate();
    // The wizard stays open on the refusal, carrying the reason, rather than
    // closing and leaving the operator to wonder whether the write landed.
    const notice = await screen.findByText(/couldn't save the template: offline/i);
    expect(screen.getByRole('dialog')).toContainElement(notice);
  });

  it('refuses to save a blank-named template, fail-loud', async () => {
    render(<KinTaleTemplates />);
    await openEditor();
    await user.clear(screen.getByLabelText('Template name'));
    // Named on the step that owns the field, not saved and then rejected.
    expect(await screen.findByText(/give the template a name/i)).toBeInTheDocument();

    const pills = within(rail()).getAllByRole('button');
    await user.click(pills[pills.length - 1]!);
    const finish = screen.getByRole('button', { name: /^save template$/i });
    expect(finish).toBeDisabled();
    await user.click(finish);
    expect(saveKinTaleTemplate).not.toHaveBeenCalled();
  });
});
/**
 * WHAT THE PER-KIN STEP ACTUALLY DRAWS, named row by row.
 *
 * The e2e phone-layout spec counts `.ktt__item` on this step, and a bare count
 * cannot tell "the built-in list grew by two" apart from "the editor drew two
 * rows twice". This names every row, so the next person who sees that count move
 * can check the cause here instead of guessing at the number.
 *
 * The list is Android's `DefaultKinTaleTemplate`; `lib/kinTale/model.ts` records
 * why Android and not the Compose desktop.
 */
describe('KinTaleTemplates: the built-in default’s per-Kin rows', () => {
  it('draws Android’s eight per-Kin items, each exactly once', async () => {
    mockStream({ status: 'ready', data: [] });
    render(<KinTaleTemplates />);
    await screen.findByText(/no templates saved yet/i);
    await openNewTemplate();
    await goToStep('Per-Kin items');
    const labels = screen
      .getAllByRole('textbox', { name: /item text/i })
      .map((el) => (el as HTMLInputElement).value);
    expect(labels).toEqual([
      'Peed',
      'Pooed',
      'Fed',
      'Fresh water provided',
      'Medications given',
      'Played',
      'Litter box scooped',
      'Water refilled after walk',
    ]);
    // Named AND deduped: eight distinct rows, not six plus two repeats.
    expect(new Set(labels).size).toBe(8);
  });
  it('draws the two per-visit items on their own step, not alongside the per-Kin ones', async () => {
    mockStream({ status: 'ready', data: [] });
    render(<KinTaleTemplates />);
    await screen.findByText(/no templates saved yet/i);
    await openNewTemplate();
    await goToStep('Per-visit items');
    expect(
      screen.getAllByRole('textbox', { name: /item text/i }).map((el) => (el as HTMLInputElement).value),
    ).toEqual(['Trash taken out', 'Lights turned off']);
  });
});

/**
 * #1591, operator ruling 2026-11-05 docket: "both". Remove moves a template to
 * an archive (restorable, hidden from the list and from new KinTales); delete
 * for good happens only from inside the archive, with the warning that says how
 * many KinTales used it.
 */
describe('KinTaleTemplates: remove, archive, delete for good (#1591)', () => {
  it('Remove asks first, says it is restorable, then archives (never deletes)', async () => {
    render(<KinTaleTemplates />);
    await user.click(await screen.findByRole('button', { name: 'Remove Walk recap' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove Walk recap?' });
    expect(within(dialog).getByText(/restore it from the archive/)).toBeInTheDocument();
    expect(removeKinTaleTemplate).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Move to archive' }));
    await waitFor(() => expect(removeKinTaleTemplate).toHaveBeenCalledWith('t1', 'archive'));
    expect(await screen.findByText('Walk recap moved to the archive.')).toBeInTheDocument();
  });

  it('an archived template leaves the list and sits in the Archive, with no Delete in the list', () => {
    mockStream({
      status: 'ready',
      data: [tpl({ _id: 't1', name: 'Walk recap' }), tpl({ _id: 't2', name: 'Old sit', isDefault: false, archived: true })],
    });
    render(<KinTaleTemplates />);
    expect(screen.queryByRole('button', { name: /^old sit/i })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore Old sit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Old sit for good' })).toBeInTheDocument();
    // The live row offers Remove only; deleting is the archive's.
    expect(screen.queryByRole('button', { name: 'Delete Walk recap for good' })).toBeNull();
  });

  it('shows no Archive panel when nothing is archived', () => {
    render(<KinTaleTemplates />);
    expect(screen.queryByRole('heading', { name: 'Archive' })).toBeNull();
  });

  it('Restore puts it back, dropping its default flag when another template took the default', async () => {
    mockStream({
      status: 'ready',
      data: [
        tpl({ _id: 't1', name: 'Walk recap', isDefault: true }),
        tpl({ _id: 't2', name: 'Old sit', isDefault: true, archived: true }),
      ],
    });
    render(<KinTaleTemplates />);
    await user.click(screen.getByRole('button', { name: 'Restore Old sit' }));
    await waitFor(() =>
      expect(removeKinTaleTemplate).toHaveBeenCalledWith('t2', 'restore', { clearDefault: true }),
    );
    expect(await screen.findByText('Old sit is back in the template list.')).toBeInTheDocument();
  });

  it('Delete for good leads with how many KinTales used it, and only then deletes', async () => {
    getKinTaleTemplateUsage.mockResolvedValue({
      templateId: 't2',
      exists: true,
      name: 'Old sit',
      isDefault: false,
      isActive: true,
      archived: true,
      kintaleCount: 3,
      otherActiveTemplateCount: 1,
    });
    mockStream({
      status: 'ready',
      data: [tpl({ _id: 't1', name: 'Walk recap' }), tpl({ _id: 't2', name: 'Old sit', isDefault: false, archived: true })],
    });
    render(<KinTaleTemplates />);
    await user.click(screen.getByRole('button', { name: 'Delete Old sit for good' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Old sit for good?' });
    expect(await within(dialog).findByText('3 KinTales were written from this template.')).toBeInTheDocument();
    expect(within(dialog).getByText(/ticked checklist items stop showing to the household/)).toBeInTheDocument();
    expect(getKinTaleTemplateUsage).toHaveBeenCalledWith('t2');
    await user.click(within(dialog).getByRole('button', { name: 'Delete for good' }));
    await waitFor(() => expect(removeKinTaleTemplate).toHaveBeenCalledWith('t2', 'delete'));
    expect(await screen.findByText('Old sit deleted for good.')).toBeInTheDocument();
  });

  it('will not delete past a count it could not read', async () => {
    getKinTaleTemplateUsage.mockRejectedValue(new Error('permission-denied'));
    mockStream({ status: 'ready', data: [tpl({ _id: 't2', name: 'Old sit', isDefault: false, archived: true })] });
    render(<KinTaleTemplates />);
    await user.click(screen.getByRole('button', { name: 'Delete Old sit for good' }));
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText(/Couldn't count the KinTales that used it: permission-denied/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Delete for good' })).toBeDisabled();
    expect(removeKinTaleTemplate).not.toHaveBeenCalled();
  });
});
