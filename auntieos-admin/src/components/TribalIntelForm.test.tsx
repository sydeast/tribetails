// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Kin, Kinfolk } from '../api/directory';
import type { TribalIntelEntry } from '../api/tribalIntel';

const { createTrainingDocument, updateTrainingDocument, uploadTribalIntelAttachment } = vi.hoisted(() => ({
  createTrainingDocument: vi.fn(),
  updateTrainingDocument: vi.fn(),
  uploadTribalIntelAttachment: vi.fn(),
}));
vi.mock('../api/tribalIntelWrite', () => ({
  createTrainingDocument,
  updateTrainingDocument,
  uploadTribalIntelAttachment,
  deleteTrainingDocument: vi.fn(),
}));

import { TribalIntelForm } from './TribalIntelForm';

const KINFOLK: Kinfolk[] = [
  { _id: 'kf1', firstName: 'Marla', lastName: 'Whitfield' },
  { _id: 'kf2', firstName: 'Dev', lastName: 'Okonkwo' },
];

const KIN: Kin[] = [
  { _id: 'kin1', kinfolkId: 'kf1', name: 'Biscuit', status: 'active' },
  { _id: 'kin2', kinfolkId: 'kf2', name: 'Pepper', status: 'active' },
];

function renderForm(over: Partial<Parameters<typeof TribalIntelForm>[0]> = {}) {
  const props = {
    editing: null,
    kinfolk: KINFOLK,
    kin: KIN,
    onCancel: vi.fn(),
    onSaved: vi.fn(),
    ...over,
  };
  render(<TribalIntelForm {...props} />);
  return props;
}

const user = userEvent.setup();

beforeEach(() => {
  createTrainingDocument.mockReset().mockResolvedValue('td-new');
  updateTrainingDocument.mockReset().mockResolvedValue('td-1');
  uploadTribalIntelAttachment.mockReset();
});

describe('TribalIntelForm', () => {
  it('states up front that saved intel folds in on the NEXT reconcile pass, never instantly', () => {
    renderForm();
    expect(screen.getByText(/next reconcile pass/i)).toBeInTheDocument();
  });

  it('creates with the exact callable payload the deployed contract parses', async () => {
    const props = renderForm();
    await user.type(screen.getByLabelText('Title'), 'Gate code');
    await user.type(screen.getByLabelText('Intel'), 'Side gate code is now 4417.');
    await user.type(screen.getByLabelText('Notes'), 'Heard at pickup');
    await user.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await user.click(screen.getByRole('button', { name: 'Save intel' }));

    expect(createTrainingDocument).toHaveBeenCalledWith({
      title: 'Gate code',
      content: 'Side gate code is now 4417.',
      notes: 'Heard at pickup',
      communicationType: 'note',
      targetType: 'HOUSEHOLD',
      targetKinfolkId: 'kf1',
      attachments: [],
    });
    expect(props.onSaved).toHaveBeenCalled();
  });

  it('offers all three targets, and starts on the household', () => {
    renderForm();
    for (const label of ['Household', 'Kinfolk', 'Kin']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Household' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('sends KINFOLK when the intel is about one human client, not the whole house', async () => {
    renderForm();
    await user.type(screen.getByLabelText('Intel'), 'Mrs. Whitfield is recovering from surgery.');
    await user.click(screen.getByRole('button', { name: 'Kinfolk' }));
    // The picker relabels itself: the same roster, named for what it is picking.
    await user.selectOptions(screen.getByLabelText('Kinfolk'), 'kf1');
    await user.click(screen.getByRole('button', { name: 'Save intel' }));

    expect(createTrainingDocument).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'KINFOLK', targetKinfolkId: 'kf1' }),
    );
    expect(createTrainingDocument.mock.calls[0]?.[0]).not.toHaveProperty('targetKinId');
  });

  it('sends HOUSEHOLD when the intel is about everyone under one roof', async () => {
    renderForm();
    await user.type(screen.getByLabelText('Intel'), 'The whole house is away over Thanksgiving.');
    await user.click(screen.getByRole('button', { name: 'Household' }));
    await user.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await user.click(screen.getByRole('button', { name: 'Save intel' }));

    expect(createTrainingDocument).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'HOUSEHOLD', targetKinfolkId: 'kf1' }),
    );
  });

  it('drops the chosen pet when the operator switches off the kin target', async () => {
    renderForm();
    await user.type(screen.getByLabelText('Intel'), 'Biscuit limps after long walks.');
    await user.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await user.click(screen.getByRole('button', { name: 'Kin' }));
    await user.selectOptions(screen.getByLabelText('Pet'), 'kin1');
    await user.click(screen.getByRole('button', { name: 'Kinfolk' }));
    await user.click(screen.getByRole('button', { name: 'Save intel' }));

    // A pet id riding along on a kinfolk-targeted save would have the note
    // filed against an animal the operator stopped naming.
    expect(createTrainingDocument.mock.calls[0]?.[0]).not.toHaveProperty('targetKinId');
  });

  it('sends targetKinId when the entry is about a single pet', async () => {
    renderForm();
    await user.type(screen.getByLabelText('Intel'), 'Biscuit limps after long walks.');
    await user.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await user.click(screen.getByRole('button', { name: 'Kin' }));
    await user.selectOptions(screen.getByLabelText('Pet'), 'kin1');
    await user.click(screen.getByRole('button', { name: 'Save intel' }));

    expect(createTrainingDocument).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'KIN', targetKinfolkId: 'kf1', targetKinId: 'kin1' }),
    );
  });

  it('only offers pets belonging to the chosen household', async () => {
    renderForm();
    await user.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await user.click(screen.getByRole('button', { name: 'Kin' }));
    const pet = screen.getByLabelText('Pet') as HTMLSelectElement;
    const names = Array.from(pet.options).map((o) => o.textContent);
    expect(names).toContain('Biscuit');
    expect(names).not.toContain('Pepper');
  });

  // ── client-side mirror of the two server refinements ───────────────────────

  it('blocks a save with no title, no content, and no attachment, before any round trip', async () => {
    renderForm();
    await user.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await user.click(screen.getByRole('button', { name: 'Save intel' }));
    expect(createTrainingDocument).not.toHaveBeenCalled();
    expect(screen.getByText('Add a title, some intel, or an attachment before saving.')).toBeInTheDocument();
  });

  it('blocks a single-pet save with no pet chosen, before any round trip', async () => {
    renderForm();
    await user.type(screen.getByLabelText('Intel'), 'Biscuit limps after long walks.');
    await user.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await user.click(screen.getByRole('button', { name: 'Kin' }));
    await user.click(screen.getByRole('button', { name: 'Save intel' }));
    expect(createTrainingDocument).not.toHaveBeenCalled();
    expect(screen.getByText('Pick which pet this intel is about.')).toBeInTheDocument();
  });

  it('blocks a save with no household chosen', async () => {
    renderForm();
    await user.type(screen.getByLabelText('Intel'), 'Something worth knowing.');
    await user.click(screen.getByRole('button', { name: 'Save intel' }));
    expect(createTrainingDocument).not.toHaveBeenCalled();
    expect(screen.getByText('Pick the household this intel belongs to.')).toBeInTheDocument();
  });

  // ── edit ──────────────────────────────────────────────────────────────────

  it('prefills every field from the entry being edited, including the pet target', () => {
    const editing: TribalIntelEntry = {
      _id: 'td-1',
      title: 'Limp watch',
      content: 'Biscuit limps after long walks.',
      notes: 'Vet call pending',
      communicationType: 'note',
      targetType: 'KIN',
      targetKinfolkId: 'kf1',
      targetKinId: 'kin1',
      attachments: [],
    };
    renderForm({ editing });
    expect(screen.getByLabelText('Title')).toHaveValue('Limp watch');
    expect(screen.getByLabelText('Intel')).toHaveValue('Biscuit limps after long walks.');
    expect(screen.getByLabelText('Notes')).toHaveValue('Vet call pending');
    expect(screen.getByLabelText('Household')).toHaveValue('kf1');
    expect(screen.getByLabelText('Pet')).toHaveValue('kin1');
    expect(screen.getByRole('button', { name: 'Kin' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('falls back to the legacy kinfolkRef when a pre-spec-23 row carries no targetKinfolkId', () => {
    renderForm({
      editing: {
        _id: 'td-legacy',
        title: 'Old note',
        content: 'Imported before the write tool existed.',
        kinfolkRef: 'kf2',
      },
    });
    expect(screen.getByLabelText('Household')).toHaveValue('kf2');
  });

  it('opens a KINFOLK entry on the kinfolk chip, never on the household one', () => {
    renderForm({
      editing: {
        _id: 'td-2',
        content: 'Mrs. Whitfield is recovering from surgery.',
        targetType: 'KINFOLK',
        targetKinfolkId: 'kf1',
      },
    });
    expect(screen.getByRole('button', { name: 'Kinfolk' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Household' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByLabelText('Kinfolk')).toHaveValue('kf1');
  });

  it('opens a legacy entry with no target type on the household chip', () => {
    // The list row reads such an entry as household-targeted; the editor has
    // to agree, or the entry says one thing in the list and another when opened.
    renderForm({
      editing: {
        _id: 'td-legacy',
        content: 'Imported before the write tool existed.',
        kinfolkRef: 'kf2',
      },
    });
    expect(screen.getByRole('button', { name: 'Household' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Household')).toHaveValue('kf2');
  });

  it('an edit routes through updateTrainingDocument with the doc id, never a second create', async () => {
    const props = renderForm({
      editing: {
        _id: 'td-1',
        title: 'Limp watch',
        content: 'Biscuit limps after long walks.',
        targetType: 'KINFOLK',
        targetKinfolkId: 'kf1',
      },
    });
    await user.click(screen.getByRole('button', { name: 'Save intel' }));
    expect(updateTrainingDocument).toHaveBeenCalledWith(
      'td-1',
      expect.objectContaining({ title: 'Limp watch', targetKinfolkId: 'kf1' }),
    );
    expect(createTrainingDocument).not.toHaveBeenCalled();
    expect(props.onSaved).toHaveBeenCalled();
  });

  // ── fail loud ─────────────────────────────────────────────────────────────

  it('surfaces a callable rejection in a fail-loud banner instead of a silent no-op', async () => {
    createTrainingDocument.mockRejectedValueOnce(new Error('permission-denied: admin claim required'));
    const props = renderForm();
    await user.type(screen.getByLabelText('Intel'), 'Something worth knowing.');
    await user.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await user.click(screen.getByRole('button', { name: 'Save intel' }));

    expect(await screen.findByText('permission-denied: admin claim required')).toBeInTheDocument();
    expect(screen.getByText('Could not save')).toBeInTheDocument();
    expect(props.onSaved).not.toHaveBeenCalled();
  });

  it('surfaces an attachment upload failure in the same banner and adds no attachment', async () => {
    uploadTribalIntelAttachment.mockRejectedValueOnce(new Error('Cloudinary upload failed (HTTP 413)'));
    renderForm();
    const file = new File(['x'], 'gate.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText('Attach a file'), file);
    expect(await screen.findByText(/Cloudinary upload failed \(HTTP 413\)/)).toBeInTheDocument();
    expect(screen.queryByText('gate.jpg')).toBeNull();
  });

  it('an uploaded attachment lists by name and rides along on the save payload', async () => {
    uploadTribalIntelAttachment.mockResolvedValueOnce({
      storageUrl: 'https://res.cloudinary.com/tt/image/upload/v1/gate.jpg',
      cloudinaryPublicId: 'tribetails/tribal_intel/pending/gate',
      fileType: 'IMAGE',
      mimeType: 'image/jpeg',
      fileName: 'gate.jpg',
    });
    renderForm();
    const file = new File(['x'], 'gate.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText('Attach a file'), file);
    expect(await screen.findByText('gate.jpg')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await user.click(screen.getByRole('button', { name: 'Save intel' }));
    expect(createTrainingDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          {
            storageUrl: 'https://res.cloudinary.com/tt/image/upload/v1/gate.jpg',
            cloudinaryPublicId: 'tribetails/tribal_intel/pending/gate',
            fileType: 'IMAGE',
            mimeType: 'image/jpeg',
            fileName: 'gate.jpg',
          },
        ],
      }),
    );
  });

  // ── the stale target (issue #460) ─────────────────────────────────────────

  const LEGACY_NAME_ROW: TribalIntelEntry = {
    _id: 'td-legacy-name',
    title: 'Old note',
    content: 'Imported before the write tool existed.',
    // The bug: a person NAME where a newer row stores an id.
    kinfolkRef: 'Marla Whitfield',
  };

  it('SHOWS a legacy name target instead of blanking the picker', () => {
    renderForm({ editing: LEGACY_NAME_ROW });
    // The select keeps the stored value selected, so the note is never silently
    // detached from whoever it was about.
    expect(screen.getByLabelText('Household')).toHaveValue('Marla Whitfield');
    expect(screen.getByRole('option', { name: 'Unresolved: "Marla Whitfield"' })).toBeInTheDocument();
  });

  it('says why the stale value cannot be saved, naming the value', () => {
    renderForm({ editing: LEGACY_NAME_ROW });
    expect(screen.getByText(/"Marla Whitfield".*not a household on the roster/)).toBeInTheDocument();
    expect(screen.getByLabelText('Household')).toHaveAttribute('aria-invalid', 'true');
  });

  it('REFUSES to save the stale value back, so no round trip is wasted', async () => {
    renderForm({ editing: LEGACY_NAME_ROW });
    await user.click(screen.getByRole('button', { name: 'Save intel' }));
    expect(updateTrainingDocument).not.toHaveBeenCalled();
  });

  it('saves once the operator picks a real household, and the warning goes', async () => {
    renderForm({ editing: LEGACY_NAME_ROW });
    await user.selectOptions(screen.getByLabelText('Household'), 'kf1');
    expect(screen.queryByRole('option', { name: 'Unresolved: "Marla Whitfield"' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save intel' }));
    expect(updateTrainingDocument).toHaveBeenCalledWith(
      'td-legacy-name',
      expect.objectContaining({ targetKinfolkId: 'kf1' }),
    );
  });

  it('flags a stale PET id too, and keeps it readable', () => {
    renderForm({
      editing: {
        _id: 'td-pet',
        content: 'About the dog.',
        targetType: 'KIN',
        targetKinfolkId: 'kf1',
        targetKinId: 'Biscuit',
      },
    });
    expect(screen.getByRole('option', { name: 'Unresolved: "Biscuit"' })).toBeInTheDocument();
    expect(screen.getByText(/"Biscuit".*not a pet on the roster/)).toBeInTheDocument();
  });

  it('does NOT accuse a target while the roster is still loading', () => {
    // An empty directory means "not loaded yet", not "every id is stale". Without
    // this guard every edit opened in that first moment would flag itself.
    renderForm({ editing: LEGACY_NAME_ROW, kinfolk: [], kin: [] });
    expect(screen.queryByText(/not a household on the roster/)).toBeNull();
  });

  it('cancel hands control back without writing anything', async () => {
    const props = renderForm();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onCancel).toHaveBeenCalled();
    expect(createTrainingDocument).not.toHaveBeenCalled();
  });
});
