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
  it('adds a KINFOLK_ATTRIBUTE / EXISTS condition: attribute dropdown shows, value input hides', async () => {
    render(<KinTaleTemplates />);
    await screen.findByDisplayValue('Walk recap');

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
