// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import {
  makeChecklistItem,
  makeMoodOption,
  type FieldCondition,
  type KinTaleTemplate,
} from '../lib/kinTale/model';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

const { saveKinTaleTemplate } = vi.hoisted(() => ({ saveKinTaleTemplate: vi.fn() }));
vi.mock('../api/kinTaleTemplatesWrite', () => ({ saveKinTaleTemplate }));

const { listChecklistBank, saveChecklistBankItem } = vi.hoisted(() => ({
  listChecklistBank: vi.fn(),
  saveChecklistBankItem: vi.fn(),
}));
vi.mock('../api/checklistBank', () => ({ listChecklistBank, saveChecklistBankItem }));

import { KinTaleTemplates } from './KinTaleTemplates';

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
  mockStream({ status: 'ready', data: [tpl()] });
});

describe('KinTaleTemplates: load + picker', () => {
  it('opens the default template into the editor', async () => {
    render(<KinTaleTemplates />);
    expect(await screen.findByDisplayValue('Walk recap')).toBeInTheDocument();
    // Service types round-trip into the CSV field.
    expect(screen.getByDisplayValue('Dog Walk')).toBeInTheDocument();
  });

  it('lists templates with a Default tag and switches when another is picked', async () => {
    mockStream({
      status: 'ready',
      data: [tpl({ _id: 't1', name: 'Walk recap', isDefault: true }), tpl({ _id: 't2', name: 'Sit recap', isDefault: false })],
    });
    render(<KinTaleTemplates />);
    // Default is auto-selected.
    expect(await screen.findByDisplayValue('Walk recap')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /sit recap/i }));
    expect(await screen.findByDisplayValue('Sit recap')).toBeInTheDocument();
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
    expect(await screen.findByDisplayValue('Default KinTale')).toBeInTheDocument();
    expect(screen.getByText(/no templates saved yet/i)).toBeInTheDocument();
  });

  it('New template starts a fresh, non-default draft', async () => {
    render(<KinTaleTemplates />);
    await screen.findByDisplayValue('Walk recap');
    await user.click(screen.getByRole('button', { name: /new template/i }));
    expect(await screen.findByDisplayValue('New template')).toBeInTheDocument();
  });
});

describe('KinTaleTemplates: checklist condition editor (the I7 payload)', () => {
  /**
   * The conditions editor lives inside the item's "Advanced" fold, so every
   * test that drives it opens the fold the way an operator has to. jsdom ships
   * no UA stylesheet and would happily click through a closed <details>, which
   * is exactly the false green worth avoiding here.
   */
  async function openAdvanced(itemLabel = 'Meds') {
    await user.click(screen.getByLabelText(`Advanced for ${itemLabel}`));
  }

  it('adds a KINFOLK_ATTRIBUTE / EXISTS condition: attribute dropdown shows, value input hides', async () => {
    render(<KinTaleTemplates />);
    await screen.findByDisplayValue('Walk recap');
    await openAdvanced();

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

    await user.click(screen.getByRole('button', { name: /save template/i }));
    await waitFor(() => expect(saveKinTaleTemplate).toHaveBeenCalledTimes(1));
    const arg = saveKinTaleTemplate.mock.calls[0]![0] as KinTaleTemplate;
    expect(arg.checklistItems[0]!.conditions[0]).toEqual<FieldCondition>({
      source: 'KINFOLK_ATTRIBUTE',
      op: 'EXISTS',
      value: '',
      attributeKey: 'serviceAddress',
    });
  });

  it('adds a KINFOLK_TAG / CONTAINS condition: no attribute dropdown, value carries the tag', async () => {
    render(<KinTaleTemplates />);
    await screen.findByDisplayValue('Walk recap');
    await openAdvanced();

    await user.click(screen.getByRole('button', { name: /add condition/i }));
    await user.selectOptions(screen.getByLabelText('When'), 'KINFOLK_TAG');
    // Tag source is not attribute-backed.
    expect(screen.queryByLabelText('Attribute')).toBeNull();

    await user.selectOptions(screen.getByLabelText('Is'), 'CONTAINS');
    await user.type(screen.getByLabelText('Value'), 'VIP');

    await user.click(screen.getByRole('button', { name: /save template/i }));
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
    await screen.findByDisplayValue('Walk recap');
    await openAdvanced();
    await user.click(screen.getByRole('button', { name: /add condition/i }));
    await user.click(screen.getByRole('button', { name: /remove condition/i }));

    await user.click(screen.getByRole('button', { name: /save template/i }));
    await waitFor(() => expect(saveKinTaleTemplate).toHaveBeenCalledTimes(1));
    const arg = saveKinTaleTemplate.mock.calls[0]![0] as KinTaleTemplate;
    expect(arg.checklistItems[0]!.conditions).toEqual([]);
  });
});

describe('KinTaleTemplates: editing the sections + items round-trips into the save', () => {
  it('save carries the section toggles, item edits, and the service types', async () => {
    render(<KinTaleTemplates />);
    await screen.findByDisplayValue('Walk recap');

    // Toggle a display section off.
    await user.click(screen.getByRole('switch', { name: 'Review booster' }));
    // Required lives in the item's "Advanced" fold; open it first, while the
    // item is still named 'Meds' (the fold is addressed by the item's text).
    await user.click(screen.getByLabelText('Advanced for Meds'));
    // Edit the one checklist item's text + required.
    await user.clear(screen.getByLabelText('Item text'));
    await user.type(screen.getByLabelText('Item text'), 'Medications given');
    await user.click(screen.getByRole('switch', { name: 'Required' }));

    await user.click(screen.getByRole('button', { name: /save template/i }));
    await waitFor(() => expect(saveKinTaleTemplate).toHaveBeenCalledTimes(1));
    const arg = saveKinTaleTemplate.mock.calls[0]![0] as KinTaleTemplate;
    expect(arg.reviewBoosterEnabled).toBe(true);
    expect(arg.serviceTypeKeys).toEqual(['Dog Walk']);
    expect(arg.checklistItems[0]).toMatchObject({ text: 'Medications given', required: true, scope: 'PER_PET' });
  });

  it('adding a per-visit item appends it in the per-visit scope', async () => {
    render(<KinTaleTemplates />);
    await screen.findByDisplayValue('Walk recap');
    const perVisit = screen.getByText('Per-visit items').closest('.den-panel') as HTMLElement;
    await user.click(within(perVisit).getByRole('button', { name: /add per-visit item/i }));

    await user.click(screen.getByRole('button', { name: /save template/i }));
    await waitFor(() => expect(saveKinTaleTemplate).toHaveBeenCalledTimes(1));
    const arg = saveKinTaleTemplate.mock.calls[0]![0] as KinTaleTemplate;
    expect(arg.checklistItems.filter((i) => i.scope === 'PER_VISIT')).toHaveLength(1);
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
    await screen.findByDisplayValue('Walk recap');
    await user.click(screen.getByRole('button', { name: /add mood/i }));

    await user.click(screen.getByRole('button', { name: /save template/i }));
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
   * The quick-add row of one checklist section. Scoped deliberately: once an
   * item is added, its own row actions ("Move X up", "Remove X") also match a
   * name query for that text, so an unscoped query would find the row it was
   * meant to prove had disappeared.
   */
  function bankRow(sectionTitle: string): HTMLElement {
    const panel = screen.getByText(sectionTitle).closest('.den-panel') as HTMLElement;
    return panel.querySelector('.ktt__bank') as HTMLElement;
  }

  it('offers the bank items for a scope, and only that scope', async () => {
    render(<KinTaleTemplates />);
    await screen.findByDisplayValue('Walk recap');
    await waitFor(() => expect(bankRow('Per-Kin items')).not.toBeNull());

    const perPet = bankRow('Per-Kin items');
    expect(within(perPet).getByRole('button', { name: /fresh water provided/i })).toBeInTheDocument();
    expect(within(perPet).queryByRole('button', { name: /home secured/i })).toBeNull();

    const perVisit = bankRow('Per-visit items');
    expect(within(perVisit).getByRole('button', { name: /home secured/i })).toBeInTheDocument();
  });

  it('clicking a bank item inserts it as a real checklist row that survives the save', async () => {
    render(<KinTaleTemplates />);
    await screen.findByDisplayValue('Walk recap');
    await waitFor(() => expect(bankRow('Per-Kin items')).not.toBeNull());

    await user.click(within(bankRow('Per-Kin items')).getByRole('button', { name: /fresh water provided/i }));

    expect(screen.getByDisplayValue('Fresh water provided')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /save template/i }));
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
    await screen.findByDisplayValue('Walk recap');
    await waitFor(() => expect(bankRow('Per-Kin items')).not.toBeNull());
    await user.click(within(bankRow('Per-Kin items')).getByRole('button', { name: /fresh water provided/i }));
    expect(bankRow('Per-Kin items')).toBeNull();
    // The per-visit row is untouched: exhausting one scope never hides another.
    expect(within(bankRow('Per-visit items')).getByRole('button', { name: /home secured/i })).toBeInTheDocument();
  });

  it('saves a hand-written item to the shared bank and offers it back', async () => {
    render(<KinTaleTemplates />);
    await screen.findByDisplayValue('Walk recap');

    listChecklistBank.mockResolvedValue([
      { id: 'fresh-water', text: 'Fresh water provided', scope: 'PER_PET' },
      { id: 'meds', text: 'Meds', scope: 'PER_PET' },
    ]);
    await user.click(screen.getByRole('button', { name: /save "meds" to the bank/i }));

    await waitFor(() => expect(saveChecklistBankItem).toHaveBeenCalledWith('Meds', 'PER_PET'));
    expect(await screen.findByText(/saved to the bank/i)).toBeInTheDocument();
  });

  it('names the reason when the bank fails to load, never a silently empty picker', async () => {
    listChecklistBank.mockRejectedValue(new Error('permission-denied'));
    render(<KinTaleTemplates />);
    await screen.findByDisplayValue('Walk recap');
    expect(await screen.findByText(/couldn't load the checklist bank: permission-denied/i)).toBeInTheDocument();
  });

  it('names the reason when saving to the bank rejects', async () => {
    saveChecklistBankItem.mockRejectedValue(new Error('unavailable'));
    render(<KinTaleTemplates />);
    await screen.findByDisplayValue('Walk recap');
    await user.click(screen.getByRole('button', { name: /save "meds" to the bank/i }));
    expect(await screen.findByText(/couldn't save to the bank: unavailable/i)).toBeInTheDocument();
  });
});

/**
 * Item 8: a checklist item shows its text and its row actions, and folds the
 * rest (Required, Show-even-when-unchecked, and the whole conditions editor)
 * into a native `<details>` "Advanced", the way `FormSchemaEditor` already does
 * per field. Six items used to mean about thirty always-open controls.
 *
 * The rule that makes folding safe is the second test: an item that carries a
 * condition, or has either toggle off its default, opens on load. Otherwise the
 * fold would hide the only signal that an item is conditional.
 *
 * `<summary>` has no implicit ARIA role, so the disclosure is addressed by its
 * `aria-label`, not `getByRole('button')`.
 */
describe('KinTaleTemplates: checklist items fold behind Advanced', () => {
  it('keeps the item text visible and folds its advanced controls away', async () => {
    render(<KinTaleTemplates />);
    const text = await screen.findByDisplayValue('Meds');
    expect(text).toBeVisible();
    // Row actions stay out of the fold: reordering and removing an item must
    // not cost a click to reveal.
    expect(screen.getByRole('button', { name: /remove meds/i })).toBeVisible();

    expect(screen.getByRole('switch', { name: 'Required' })).not.toBeVisible();
    expect(screen.getByRole('switch', { name: 'Show even when unchecked' })).not.toBeVisible();
    expect(screen.getByRole('button', { name: /add condition/i })).not.toBeVisible();

    await user.click(screen.getByLabelText('Advanced for Meds'));
    expect(screen.getByRole('switch', { name: 'Required' })).toBeVisible();
    expect(screen.getByRole('button', { name: /add condition/i })).toBeVisible();
  });

  it('opens an item automatically when it already carries a condition', async () => {
    mockStream({
      status: 'ready',
      data: [
        tpl({
          checklistItems: [
            makeChecklistItem({
              key: 'meds',
              text: 'Medications given',
              scope: 'PER_PET',
              order: 0,
              conditions: [{ source: 'KIN_SPECIES', op: 'EQUALS', value: 'dog', attributeKey: '' }],
            }),
          ],
        }),
      ],
    });
    render(<KinTaleTemplates />);
    expect(await screen.findByText(/only show when the pet's species is dog/i)).toBeVisible();
  });

  it('opens an item whose toggles are off their defaults, so nothing configured hides', async () => {
    mockStream({
      status: 'ready',
      data: [
        tpl({
          checklistItems: [
            makeChecklistItem({ key: 'meds', text: 'Meds', scope: 'PER_PET', order: 0, required: true }),
          ],
        }),
      ],
    });
    render(<KinTaleTemplates />);
    await screen.findByDisplayValue('Meds');
    expect(screen.getByRole('switch', { name: 'Required' })).toBeVisible();
  });

  it('leaves the fold where the operator put it when they turn a toggle back off', async () => {
    // The open state is the operator's, not a re-derivation: clearing Required
    // inside an open item must not slam the panel shut mid-edit.
    mockStream({
      status: 'ready',
      data: [
        tpl({
          checklistItems: [
            makeChecklistItem({ key: 'meds', text: 'Meds', scope: 'PER_PET', order: 0, required: true }),
          ],
        }),
      ],
    });
    render(<KinTaleTemplates />);
    await screen.findByDisplayValue('Meds');
    await user.click(screen.getByRole('switch', { name: 'Required' }));
    expect(screen.getByRole('switch', { name: 'Required' })).toBeVisible();
  });
});

describe('KinTaleTemplates: default exclusivity', () => {
  it('hands the writer the streamed siblings, so setting default can unset the others', async () => {
    mockStream({
      status: 'ready',
      data: [tpl({ _id: 't1', name: 'Walk recap', isDefault: true }), tpl({ _id: 't2', name: 'Sit recap', isDefault: false })],
    });
    render(<KinTaleTemplates />);
    await screen.findByDisplayValue('Walk recap');
    await user.click(screen.getByRole('button', { name: /sit recap/i }));
    await screen.findByDisplayValue('Sit recap');
    await user.click(screen.getByRole('switch', { name: 'Make default template' }));

    await user.click(screen.getByRole('button', { name: /save template/i }));
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
    await screen.findByDisplayValue('Walk recap');
    await user.click(screen.getByRole('button', { name: /sit recap/i }));
    await screen.findByDisplayValue('Sit recap');
    await user.click(screen.getByRole('switch', { name: 'Make default template' }));
    expect(screen.getByText(/only one template can be the default/i)).toBeInTheDocument();
  });
});

describe('KinTaleTemplates: save, fail-loud', () => {
  it('shows a success banner after a save', async () => {
    render(<KinTaleTemplates />);
    await screen.findByDisplayValue('Walk recap');
    await user.click(screen.getByRole('button', { name: /save template/i }));
    expect(await screen.findByText(/template saved/i)).toBeInTheDocument();
  });

  it('names the reason when the save rejects, never a fake success', async () => {
    saveKinTaleTemplate.mockRejectedValue(new Error('offline'));
    render(<KinTaleTemplates />);
    await screen.findByDisplayValue('Walk recap');
    await user.click(screen.getByRole('button', { name: /save template/i }));
    expect(await screen.findByText(/couldn't save the template: offline/i)).toBeInTheDocument();
  });

  it('refuses to save a blank-named template, fail-loud', async () => {
    render(<KinTaleTemplates />);
    await screen.findByDisplayValue('Walk recap');
    await user.clear(screen.getByLabelText('Template name'));
    await user.click(screen.getByRole('button', { name: /save template/i }));
    expect(await screen.findByText(/give the template a name/i)).toBeInTheDocument();
    expect(saveKinTaleTemplate).not.toHaveBeenCalled();
  });
});
