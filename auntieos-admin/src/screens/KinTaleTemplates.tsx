import { useEffect, useId, useState } from 'react';
import { linkOptions } from '@tanstack/react-router';
import { useCollection } from '../lib/firestore';
import { type Async } from '../lib/async';
import {
  KINTALE_TEMPLATES_QUERY,
  decodeKinTaleTemplate,
  pickInitialTemplate,
} from '../api/kinTaleTemplates';
import { saveKinTaleTemplate } from '../api/kinTaleTemplatesWrite';
import { getBusinessSettings } from '../api/settings';
import { serviceOptionsFromRates, type ServiceOption } from '../lib/newBooking';
import { listChecklistBank, saveChecklistBankItem } from '../api/checklistBank';
import {
  bankItemsForScope,
  normalizeBankScope,
  checklistItemFromBank,
  type ChecklistBankItem,
} from '../lib/checklistBank';
import {
  ConditionSource,
  type ChecklistItem,
  type FieldCondition,
  type KinTaleTemplate,
} from '../lib/kinTale/model';
import {
  conditionSourceOptions,
  conditionSummary,
  conditionUsesAttributeKey,
  conditionUsesValueInput,
} from '../lib/kinTale/engine';
import {
  addChecklistItem,
  addCondition,
  addMood,
  attributeCatalogForSource,
  changeConditionSource,
  freshChecklistKey,
  newTemplateDraft,
  nextOrderForScope,
  opLabel,
  perPetItems,
  perVisitItems,
  removeChecklistItem,
  removeCondition,
  removeMood,
  reorderChecklistItem,
  reorderMood,
  seedTemplateDraft,
  serviceTypeChoices,
  sortedMoods,
  toggleServiceTypeKey,
  updateChecklistItem,
  updateCondition,
  updateMood,
  valuePlaceholder,
} from '../lib/kinTaleTemplateEdit';
import { ConditionOp } from '../lib/kinTale/model';
import { DenScreenHeading, DenPanel, EmptyHint, StatusPill } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { WizardModal, type WizardStep } from '../components/WizardModal';
import { GhostButton, IconButton } from '../components/Buttons';
import { Toggle } from '../components/Toggle';
import { Banner } from '../components/Banner';
import './KinTaleTemplates.css';

/**
 * KinTale TEMPLATE EDITOR (React admin port of the Compose
 * `KinTaleTemplateEditorScreen.kt`). Auntie shapes the visit recap: which
 * sections show, which service types a template covers, the pet-mood palette,
 * and the per-pet / per-visit checklist, each item carrying optional visibility
 * conditions evaluated by the shared engine (`lib/kinTale/engine.ts`).
 *
 * A picker of saved templates on the screen, and the editor for the picked one
 * IN A WORKFLOW MODAL, one section per step (`components/WizardModal`), on the
 * operator's instruction of 2026-08-08. The 2026-08-06 layout review named this
 * the tallest screen in the mock set: five always-expanded panels stacked in one
 * column, with the checklist panels growing without bound as items are added.
 * Splitting those panels across named steps is the chosen answer. The picker
 * stays behind the modal rather than being replaced by it, so backing out
 * returns to exactly the row that was clicked.
 *
 * NOTHING IS FOLDED. Every field a step owns is drawn in full on that step:
 * answering this screen's length with an "Advanced" disclosure was rejected by
 * operator ruling on 2026-08-08, because the mocks draw every field expanded.
 * Named, directly navigable steps are a different answer, and the difference is
 * that no step hides anything inside itself.
 *
 * Templates stream live from `kintale_templates` (bounded `useCollection`);
 * saves are direct rules-backed Firestore writes (`saveKinTaleTemplate`),
 * fail-loud.
 *
 * WHAT CHANGED WITH THE MODAL, disclosed rather than left to be discovered:
 *  - The screen no longer auto-opens the default template into a visible editor.
 *    Nothing is being edited until a picker row (or "New template") is clicked,
 *    which is what makes "Discard changes" true: the draft lives in the wizard
 *    and dies with it, so a discarded edit is really gone.
 *  - The heading's Save button and its Saved/Unsaved-changes pill are gone. Save
 *    is the wizard's finish action, and with no editor outside the modal there is
 *    no unsaved state for a pill to report.
 *  - The draft starts CLEAN even for a new template (the old screen marked a
 *    fresh draft dirty on creation), so opening "New template" and immediately
 *    backing out does not demand a discard confirmation for zero typed work.
 *
 * PORT NOTES, disclosed rather than silent:
 *  - Service types: the Compose editor has no service-type field; this port adds
 *    a checkbox per KinCare type, read from `business_settings.serviceRates`
 *    (`serviceOptionsFromRates`, the same catalog Schedule and the new-visit
 *    dialog read; name + duration + price since #373). It used to be a
 *    comma-separated free-text field, which mark 23 of the 2026-08-17 walk ruled
 *    out for the whole screen: a known set of choices must be represented as
 *    that set, not typed. A key the template already stores that the catalog no
 *    longer recognises (renamed, retired, or the catalog failed to load) is
 *    still shown, checked, and flagged rather than silently dropped.
 *  - Checklist item `key` is auto-managed (`item_N`), exactly as Compose does it;
 *    it is never a hand-typed field, so it round-trips without an input.
 *  - The shared "checklist bank" quick-add is WIRED (`listChecklistBank` /
 *    `saveChecklistBankItem`, both deployed admin callables). Each checklist
 *    section gets an "Add from bank" row of items it does not already carry, and
 *    each hand-written item gets a "Save to bank" action, ports of the archive's
 *    `BankAddRow` / `onSaveToBank`.
 *  - `isDefault` is EXCLUSIVE: setting it here clears the flag on every other
 *    template in one batched write (see `api/kinTaleTemplatesWrite.ts` for why
 *    global, not per service scope). Compose let the flag pile up, which left
 *    "the default" meaning whichever flagged doc the snapshot listed first.
 */

type ScreenBanner = { tone: 'error' | 'success'; text: string };

/** What the wizard is open on: a stored template, or a fresh draft. */
type EditorTarget = { seed: KinTaleTemplate; isNew: boolean };

export function KinTaleTemplates() {
  const stream = useCollection<Record<string, unknown>>(KINTALE_TEMPLATES_QUERY);
  const templates: KinTaleTemplate[] =
    stream.status === 'ready' ? stream.data.map(decodeKinTaleTemplate) : [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditorTarget | null>(null);
  const [banner, setBanner] = useState<ScreenBanner | null>(null);
  const [bank, setBank] = useState<readonly ChecklistBankItem[]>([]);
  const [serviceCatalog, setServiceCatalog] = useState<Async<ServiceOption[]>>({ status: 'loading' });

  // The shared bank, loaded once (the archive's `LaunchedEffect(Unit)`). A read
  // failure names itself in the banner rather than leaving an empty quick-add
  // row that reads as "the bank is empty". This one stays SCREEN-level on
  // purpose: it fires on mount, before any modal can be covering it.
  useEffect(() => {
    let cancelled = false;
    void listChecklistBank()
      .then((items) => {
        if (!cancelled) setBank(items);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBanner({
          tone: 'error',
          text: `Couldn't load the checklist bank: ${err instanceof Error ? err.message : 'unknown error'}`,
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The operator's real KinCare types, read ONCE at screen level (same
  // `business_settings.serviceRates` + `serviceDurations` Schedule and the
  // new-visit dialog read) so the "Service types" checkboxes and the
  // SERVICE_TYPE condition-value suggestions both draw from one catalog. A
  // failed load is kept as its own error state rather than falling back to an
  // empty list: the Basic Settings step reads it directly, so it can still
  // show what the draft already has selected instead of silently losing them.
  useEffect(() => {
    let cancelled = false;
    void getBusinessSettings()
      .then((s) => {
        if (cancelled) return;
        setServiceCatalog({ status: 'ready', data: serviceOptionsFromRates(s.serviceRates, s.serviceDurations) });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setServiceCatalog({
          status: 'error',
          message: err instanceof Error ? err.message : 'unknown error',
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Writes one item to the shared bank and re-reads it. THROWS on failure rather
   * than reporting: "Save to bank" is pressed from inside the wizard, and a
   * banner painted on the screen behind an open modal is a banner the operator
   * never sees, so the wizard reports its own outcome (see `TemplateWizard`).
   */
  async function handleSaveToBank(text: string, scope: string) {
    await saveChecklistBankItem(text, scope);
    setBank(await listChecklistBank());
  }

  // Highlight a sensible row once data lands, and never again: this only fires
  // while nothing is selected yet, so a later stream tick (e.g. our own save
  // landing) never moves the selection under the operator. Mirrors the Compose
  // editor's one-shot `LaunchedEffect(templatesRes)` default-selection, but it
  // only selects now, it does not open an editor.
  useEffect(() => {
    if (stream.status !== 'ready' || selectedId !== null) return;
    const first = pickInitialTemplate(stream.data.map(decodeKinTaleTemplate));
    setSelectedId(first ? first._id : '');
  }, [stream, selectedId]);

  function selectTemplate(tpl: KinTaleTemplate) {
    setSelectedId(tpl._id);
    setBanner(null);
    setEditing({ seed: tpl, isNew: false });
  }

  /**
   * With nothing saved yet, a new template starts from the BUILT-IN DEFAULT
   * (`seedTemplateDraft`) rather than an empty one, which is the
   * create-from-default path the pre-modal screen had: it pre-seeded that draft
   * into the always-visible editor. Once there is at least one saved template,
   * "new" means new (`newTemplateDraft`).
   */
  function startNewTemplate() {
    setSelectedId('');
    setBanner(null);
    setEditing({ seed: templates.length === 0 ? seedTemplateDraft() : newTemplateDraft(), isNew: true });
  }

  function handleSaved(id: string) {
    setSelectedId(id);
    setEditing(null);
    setBanner({ tone: 'success', text: 'Template saved.' });
  }

  return (
    <div className="screen kintale-templates">
      {/* The template-editor mock's trail, "KinTales / Templates": this screen
          is reached from the list's Edit templates control, so it is nested
          under KinTales and carries the trail in the kicker's place. */}
      <DenScreenHeading
        crumbs={[{ label: 'KinTales', link: linkOptions({ to: '/kintales' }) }, { label: 'Templates' }]}
        title="KinTale"
        accentTail="templates."
        subtitle="Shape the recap that goes home: which sections show, and the checklist Auntie fills out each visit."
      />

      {banner && (
        <Banner tone={banner.tone} onDismiss={() => setBanner(null)}>
          {banner.text}
        </Banner>
      )}

      <AsyncRegion
        state={stream}
        what="KinTale templates"
        isEmpty={() => false}
        empty={null}
        loading={<p className="ktt__hint">Loading templates…</p>}
      >
        {() => (
          <TemplatePicker
            templates={templates}
            selectedId={selectedId}
            onSelect={selectTemplate}
            onAddNew={startNewTemplate}
          />
        )}
      </AsyncRegion>

      {editing && (
        /*
          Keyed by what it is editing, so picking a different template mounts a
          FRESH wizard seeded from that row instead of leaving the previous
          draft (and its dirty flag) in place.
        */
        <TemplateWizard
          key={editing.isNew ? 'new' : editing.seed._id}
          seed={editing.seed}
          isNew={editing.isNew}
          siblings={templates.map((t) => ({ _id: t._id, isDefault: t.isDefault }))}
          bank={bank}
          serviceCatalog={serviceCatalog}
          onSaveToBank={handleSaveToBank}
          onSaved={handleSaved}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

// ── template picker ──────────────────────────────────────────────────────────

interface TemplatePickerProps {
  templates: readonly KinTaleTemplate[];
  selectedId: string | null;
  onSelect: (tpl: KinTaleTemplate) => void;
  onAddNew: () => void;
}

function TemplatePicker({ templates, selectedId, onSelect, onAddNew }: TemplatePickerProps) {
  return (
    <DenPanel
      title="Templates"
      subtitle="Pick one to edit, or start a new one."
      trailing={<GhostButton label="New template" onClick={onAddNew} />}
    >
      {templates.length === 0 ? (
        <EmptyHint>
          No templates saved yet. &ldquo;New template&rdquo; starts from the built-in default, ready to save
          as your first.
        </EmptyHint>
      ) : (
        <ul className="ktt__picker">
          {templates.map((tpl) => {
            const active = tpl._id === selectedId;
            return (
              <li key={tpl._id}>
                <button
                  type="button"
                  className={`ktt__picker-row${active ? ' ktt__picker-row--active' : ''}`}
                  aria-pressed={active}
                  onClick={() => onSelect(tpl)}
                >
                  <span className="ktt__picker-name">{tpl.name.trim() || 'Untitled template'}</span>
                  {/* The mock's `.tag.def` / `.tag.ina`: the kit capsule at
                      the compact size, orange for the default, muted for an
                      inactive one. */}
                  {tpl.isDefault && <StatusPill label="Default" tone="orange" size="compact" />}
                  {!tpl.isActive && <StatusPill label="Inactive" tone="muted" size="compact" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </DenPanel>
  );
}

// ── the editor, as a workflow modal ──────────────────────────────────────────

interface TemplateWizardProps {
  /** The template this wizard opened on. Copied into the draft once, on mount. */
  seed: KinTaleTemplate;
  isNew: boolean;
  /** Every stored template's id + default flag, for exclusivity on save. */
  siblings: ReadonlyArray<{ _id: string; isDefault: boolean }>;
  bank: readonly ChecklistBankItem[];
  /** The operator's KinCare types, for the Service types checkboxes and the SERVICE_TYPE condition suggestions. */
  serviceCatalog: Async<ServiceOption[]>;
  /** Writes to the shared bank and refreshes it. Rejects on failure; this reports it. */
  onSaveToBank: (text: string, scope: string) => Promise<void>;
  onSaved: (templateId: string) => void;
  onClose: () => void;
}

/**
 * The editor, one section per step.
 *
 * IT OWNS THE DRAFT. That is deliberate and it is what makes the unsaved-work
 * guard honest: WizardModal's confirmation says closing "throws them away", and
 * that is only true if the edits die with the component. A draft parked on the
 * screen behind the modal would survive the discard the operator just confirmed.
 *
 * STEPS ARE A FILTERED ARRAY, rebuilt every render. The two checklist steps and
 * the mood step exist only while their display-section toggle is on, exactly the
 * conditional case `lib/wizardFlow.ts` was built for; turning a toggle off drops
 * the step but never the data, so flipping it back finds the items still there.
 */
function TemplateWizard({
  seed,
  isNew,
  siblings,
  bank,
  serviceCatalog,
  onSaveToBank,
  onSaved,
  onClose,
}: TemplateWizardProps) {
  const [draft, setDraft] = useState<KinTaleTemplate>(seed);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<ScreenBanner | null>(null);
  const serviceTypeNames = serviceCatalog.status === 'ready' ? serviceCatalog.data.map((o) => o.name) : [];
  const [step, setStep] = useState('basic');

  // The editor's one validation rule, owned by the step that owns the field, so
  // the rail can flag it from anywhere instead of the operator finding out at save.
  const nameErrors = draft.name.trim() === '' ? ['Give the template a name before saving.'] : [];
  const displacesDefault = draft.isDefault && siblings.some((t) => t.isDefault && t._id !== draft._id);

  function patch(p: Partial<KinTaleTemplate>) {
    setDraft((d) => ({ ...d, ...p }));
    setDirty(true);
  }

  /**
   * Reported HERE, in the wizard's own notice, rather than on the screen the
   * modal is covering. Same rule the flow-level banner exists for: a message
   * only visible where the operator is not standing is a message they miss.
   */
  async function saveToBank(text: string, scope: string) {
    const trimmed = text.trim();
    if (trimmed === '') {
      setNotice({ tone: 'error', text: 'Give the item some text before saving it to the bank.' });
      return;
    }
    try {
      await onSaveToBank(trimmed, scope);
      setNotice({ tone: 'success', text: `"${trimmed}" saved to the bank.` });
    } catch (err) {
      setNotice({
        tone: 'error',
        text: `Couldn't save to the bank: ${err instanceof Error ? err.message : 'unknown error'}`,
      });
    }
  }

  async function handleSave() {
    if (saving || nameErrors.length > 0) return;
    setSaving(true);
    setNotice(null);
    try {
      // The streamed list doubles as the sibling set for default exclusivity, so
      // the writer needn't re-read a collection this screen is already holding.
      const id = await saveKinTaleTemplate(draft, siblings);
      setSaving(false);
      // Cleared BEFORE handing back: the caller closes the wizard, and a stale
      // dirty flag would ask the operator to confirm discarding work that has
      // just been written.
      setDirty(false);
      onSaved(id);
    } catch (err) {
      setSaving(false);
      setNotice({
        tone: 'error',
        text: `Couldn't save the template: ${err instanceof Error ? err.message : 'unknown error'}`,
      });
    }
  }

  const steps: WizardStep[] = [
    {
      key: 'basic',
      label: 'Basic settings',
      blurb: 'Name it, and say when it applies.',
      errors: nameErrors,
      body: (
        <BasicSettingsStep
          draft={draft}
          patch={patch}
          displacesDefault={displacesDefault}
          serviceCatalog={serviceCatalog}
        />
      ),
    },
    {
      key: 'sections',
      label: 'Display sections',
      blurb: 'Which blocks appear in the recap.',
      body: <DisplaySectionsStep draft={draft} patch={patch} />,
    },
    ...(draft.checklistEnabled
      ? [
          {
            key: 'per-kin',
            label: 'Per-Kin items',
            blurb: 'These appear once for each Kin in the visit.',
            body: (
              <ChecklistSection
                scope="PER_PET"
                addLabel="Add per-Kin item"
                items={draft.checklistItems}
                onItems={(items) => patch({ checklistItems: items })}
                bank={bank}
                serviceTypeNames={serviceTypeNames}
                onSaveToBank={(text, scope) => void saveToBank(text, scope)}
              />
            ),
          },
          {
            key: 'per-visit',
            label: 'Per-visit items',
            blurb: 'These appear once for the whole visit.',
            body: (
              <ChecklistSection
                scope="PER_VISIT"
                addLabel="Add per-visit item"
                items={draft.checklistItems}
                onItems={(items) => patch({ checklistItems: items })}
                bank={bank}
                serviceTypeNames={serviceTypeNames}
                onSaveToBank={(text, scope) => void saveToBank(text, scope)}
              />
            ),
          },
        ]
      : []),
    ...(draft.petMoodEnabled
      ? [
          {
            key: 'moods',
            label: 'Mood options',
            blurb: "The palette Auntie tags each Kin's mood from.",
            body: (
              <MoodEditor moods={draft.moodOptions} onMoods={(moods) => patch({ moodOptions: moods })} />
            ),
          },
        ]
      : []),
  ];

  return (
    <WizardModal
      title={isNew ? 'New KinTale template' : 'Edit KinTale template'}
      steps={steps}
      currentStepKey={step}
      onStepChange={setStep}
      onClose={onClose}
      dirty={dirty}
      onFinish={() => void handleSave()}
      finishLabel={saving ? 'Saving…' : 'Save template'}
      finishBusy={saving}
      notice={
        notice && (
          <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>
            {notice.text}
          </Banner>
        )
      }
    />
  );
}

// ── step bodies ──────────────────────────────────────────────────────────────

interface StepBodyProps {
  draft: KinTaleTemplate;
  patch: (p: Partial<KinTaleTemplate>) => void;
}

function BasicSettingsStep({
  draft,
  patch,
  displacesDefault,
  serviceCatalog,
}: StepBodyProps & { displacesDefault: boolean; serviceCatalog: Async<ServiceOption[]> }) {
  const serviceTypesLabelId = useId();
  const catalogNames = serviceCatalog.status === 'ready' ? serviceCatalog.data.map((o) => o.name) : [];
  const choices = serviceTypeChoices(catalogNames, draft.serviceTypeKeys);

  return (
    <>
      <label className="ktt__field">
        <span className="ktt__label">Template name</span>
        <input
          type="text"
          className="ktt__input"
          value={draft.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="e.g. Dog walk recap"
        />
      </label>

      <label className="ktt__field">
        <span className="ktt__label">Description</span>
        <textarea
          className="ktt__textarea"
          value={draft.description}
          onChange={(e) => patch({ description: e.target.value })}
          placeholder="What kind of visits is this template for?"
          rows={2}
        />
      </label>

      <label className="ktt__field">
        <span className="ktt__label">Default message to kinfolk</span>
        <textarea
          className="ktt__textarea"
          value={draft.defaultEmailMessage}
          onChange={(e) => patch({ defaultEmailMessage: e.target.value })}
          placeholder="The note that opens the recap. Write what actually happened on this visit."
          rows={3}
        />
      </label>
      <p className="ktt__note">
        No default on purpose: a canned message here invited sending it unedited. Auntie writes it fresh
        each time.
      </p>

      <div className="ktt__field">
        <span className="ktt__label" id={serviceTypesLabelId}>
          Service types
        </span>
        {serviceCatalog.status === 'loading' && <p className="ktt__hint">Loading your KinCare types…</p>}
        {serviceCatalog.status === 'error' && (
          <p className="ktt__note ktt__note--error" role="alert">
            Couldn&rsquo;t load your KinCare types ({serviceCatalog.message}). Anything already picked is
            still shown below and can be unticked; picking a new type will work again once the load
            recovers.
          </p>
        )}
        {serviceCatalog.status === 'ready' && serviceCatalog.data.length === 0 && (
          <p className="ktt__hint">No KinCare types configured yet. Add them in Settings first.</p>
        )}
        {choices.length > 0 && (
          <div role="group" aria-labelledby={serviceTypesLabelId} className="ktt__serviceTypes">
            {choices.map((choice) => (
              <label
                key={choice.name}
                className={choice.stale ? 'ktt__chip ktt__chip--stale' : 'ktt__chip'}
              >
                <input
                  type="checkbox"
                  checked={choice.checked}
                  onChange={(e) =>
                    patch({
                      serviceTypeKeys: toggleServiceTypeKey(draft.serviceTypeKeys, choice.name, e.target.checked),
                    })
                  }
                />
                <span>{choice.name}</span>
                {choice.stale && (
                  <span className="ktt__chip-flag">not in your current KinCare types</span>
                )}
              </label>
            ))}
          </div>
        )}
      </div>
      <p className="ktt__note">Leave every box unticked to let this template match any service type.</p>

      <ToggleRow
        label="Make default template"
        description="Chosen automatically when no service-specific template matches a visit."
        checked={draft.isDefault}
        onChange={(v) => patch({ isDefault: v })}
      />
      {displacesDefault && (
        <p className="ktt__note">
          Only one template can be the default. Saving this one clears the flag on the template that
          holds it now.
        </p>
      )}
      <ToggleRow
        label="Active"
        description="Inactive templates are never picked by the composer."
        checked={draft.isActive}
        onChange={(v) => patch({ isActive: v })}
      />
    </>
  );
}

function DisplaySectionsStep({ draft, patch }: StepBodyProps) {
  return (
    <>
      <ToggleRow
        label="Photo & video showcase"
        description="Let Auntie attach photos and videos to the KinTale."
        checked={draft.photoShowcaseEnabled}
        onChange={(v) => patch({ photoShowcaseEnabled: v })}
      />
      <ToggleRow
        label="Checklist"
        description="The per-pet and per-visit checklist items."
        checked={draft.checklistEnabled}
        onChange={(v) => patch({ checklistEnabled: v })}
      />
      <ToggleRow
        label="Visit notes"
        description="A free-text note from Auntie to the kinfolk."
        checked={draft.visitNotesEnabled}
        onChange={(v) => patch({ visitNotesEnabled: v })}
      />
      <ToggleRow
        label="Next appointment"
        description="Show the kinfolk's next booking with a gentle nudge to book again."
        checked={draft.nextAppointmentEnabled}
        onChange={(v) => patch({ nextAppointmentEnabled: v })}
      />
      <ToggleRow
        label="Kin mood"
        description="Let Auntie tag each Kin's mood from the palette below."
        checked={draft.petMoodEnabled}
        onChange={(v) => patch({ petMoodEnabled: v })}
      />
      <ToggleRow
        label="Review booster"
        description="Add a section inviting the kinfolk to leave a review."
        checked={draft.reviewBoosterEnabled}
        onChange={(v) => patch({ reviewBoosterEnabled: v })}
      />
    </>
  );
}

// ── toggle row ───────────────────────────────────────────────────────────────

interface ToggleRowProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

function ToggleRow({ label, description, checked, onChange }: ToggleRowProps) {
  return (
    <div className="ktt__toggle-row">
      <div className="ktt__toggle-copy">
        <span className="ktt__toggle-label">{label}</span>
        <span className="ktt__toggle-desc">{description}</span>
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

// ── checklist section ────────────────────────────────────────────────────────

interface ChecklistSectionProps {
  scope: string;
  addLabel: string;
  items: ChecklistItem[];
  onItems: (items: ChecklistItem[]) => void;
  bank: readonly ChecklistBankItem[];
  /** The real KinCare type names, for the SERVICE_TYPE condition's value suggestions. */
  serviceTypeNames: readonly string[];
  onSaveToBank: (text: string, scope: string) => void;
}

/**
 * One checklist scope's items. No `DenPanel` and no title of its own: this is a
 * wizard step body now, and the step already draws the heading and the blurb, so
 * a panel inside it would title the same section twice.
 */
function ChecklistSection({
  scope,
  addLabel,
  items,
  onItems,
  bank,
  serviceTypeNames,
  onSaveToBank,
}: ChecklistSectionProps) {
  const rows = scope === 'PER_PET' ? perPetItems(items) : perVisitItems(items);
  return (
    <>
      <div className="ktt__step-actions">
        <GhostButton label={addLabel} onClick={() => onItems(addChecklistItem(items, scope))} />
      </div>
      {rows.length === 0 ? (
        <EmptyHint>No items yet.</EmptyHint>
      ) : (
        <ul className="ktt__items">
          {rows.map((item, idx) => (
            <ChecklistItemCard
              key={`${item.scope}:${item.key}`}
              item={item}
              items={items}
              isFirst={idx === 0}
              isLast={idx === rows.length - 1}
              onItems={onItems}
              serviceTypeNames={serviceTypeNames}
              onSaveToBank={onSaveToBank}
            />
          ))}
        </ul>
      )}
      <BankAddRow bank={bank} items={items} scope={scope} onItems={onItems} />
    </>
  );
}

interface BankAddRowProps {
  bank: readonly ChecklistBankItem[];
  items: ChecklistItem[];
  scope: string;
  onItems: (items: ChecklistItem[]) => void;
}

/**
 * "Add from bank": the shared-bank items for this scope that the checklist does
 * not already carry, one click each. Ported from the archive's `BankAddRow`,
 * including its rule that the row hides entirely when nothing is left to offer,
 * rather than sitting there as an empty heading.
 */
function BankAddRow({ bank, items, scope, onItems }: BankAddRowProps) {
  const available = bankItemsForScope(bank, items, scope);
  if (available.length === 0) return null;
  return (
    <div className="ktt__bank">
      <span className="ktt__bank-title">Add from bank</span>
      <ul className="ktt__bank-list">
        {available.map((b) => (
          <li key={b.id || b.text}>
            <button
              type="button"
              className="ktt__bank-item"
              onClick={() =>
                onItems([
                  ...items,
                  checklistItemFromBank(
                    b,
                    freshChecklistKey(items),
                    nextOrderForScope(items, normalizeBankScope(b.scope)),
                  ),
                ])
              }
            >
              <span aria-hidden="true">+</span> {b.text}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface ChecklistItemCardProps {
  item: ChecklistItem;
  items: ChecklistItem[];
  isFirst: boolean;
  isLast: boolean;
  onItems: (items: ChecklistItem[]) => void;
  serviceTypeNames: readonly string[];
  onSaveToBank: (text: string, scope: string) => void;
}

function ChecklistItemCard({
  item,
  items,
  isFirst,
  isLast,
  onItems,
  serviceTypeNames,
  onSaveToBank,
}: ChecklistItemCardProps) {
  const label = item.text.trim() || 'this item';

  function update(patch: Partial<ChecklistItem>) {
    onItems(updateChecklistItem(items, item.key, item.scope, patch));
  }
  function setConditions(conditions: FieldCondition[]) {
    update({ conditions });
  }

  return (
    <li className="ktt__item">
      <div className="ktt__item-head">
        <label className="ktt__field ktt__field--grow">
          <span className="ktt__label">Item text</span>
          <input
            type="text"
            className="ktt__input"
            value={item.text}
            onChange={(e) => update({ text: e.target.value })}
            placeholder="e.g. Peed"
          />
        </label>
        <div className="ktt__item-actions">
          {/* Promotes a hand-written item into the shared bank, so the next
              template gets it as a one-click add (archive `onSaveToBank`). */}
          <IconButton
            icon={<BankGlyph />}
            label={`Save "${label}" to the bank`}
            onClick={() => onSaveToBank(item.text, item.scope)}
            disabled={item.text.trim() === ''}
            size={32}
          />
          <IconButton
            icon={<UpGlyph />}
            label={`Move ${label} up`}
            onClick={() => onItems(reorderChecklistItem(items, item.key, item.scope, -1))}
            disabled={isFirst}
            size={32}
          />
          <IconButton
            icon={<DownGlyph />}
            label={`Move ${label} down`}
            onClick={() => onItems(reorderChecklistItem(items, item.key, item.scope, 1))}
            disabled={isLast}
            size={32}
          />
          <IconButton
            icon={<TrashGlyph />}
            label={`Remove ${label}`}
            onClick={() => onItems(removeChecklistItem(items, item.key, item.scope))}
            destructive
            size={32}
          />
        </div>
      </div>

      <div className="ktt__item-toggles">
        <ToggleRow
          label="Required"
          description="Mark this item as one Auntie must fill in."
          checked={item.required}
          onChange={(v) => update({ required: v })}
        />
        <ToggleRow
          label="Show even when unchecked"
          description="Off: unchecked items are hidden from the kinfolk. On: shown with a 'no' marker."
          checked={item.showWhenUnchecked}
          onChange={(v) => update({ showWhenUnchecked: v })}
        />
      </div>

      <ConditionsEditor
        conditions={item.conditions}
        onConditions={setConditions}
        serviceTypeNames={serviceTypeNames}
      />
    </li>
  );
}

// ── conditions editor (the I7 payload) ───────────────────────────────────────

interface ConditionsEditorProps {
  conditions: FieldCondition[];
  onConditions: (conditions: FieldCondition[]) => void;
  /** The real KinCare type names, offered as suggestions on a SERVICE_TYPE condition's value. */
  serviceTypeNames: readonly string[];
}

function ConditionsEditor({ conditions, onConditions, serviceTypeNames }: ConditionsEditorProps) {
  return (
    <div className="ktt__conditions">
      <div className="ktt__conditions-head">
        <span className="ktt__conditions-title">Conditions</span>
        <GhostButton label="Add condition" onClick={() => onConditions(addCondition(conditions))} />
      </div>
      {conditions.length === 0 ? (
        <p className="ktt__note">
          Always shown. Add a condition to show this item only for certain pets, households, or services.
        </p>
      ) : (
        <ul className="ktt__condition-list">
          {conditions.map((cond, idx) => (
            <ConditionRow
              key={idx}
              condition={cond}
              onChange={(next) => onConditions(updateCondition(conditions, idx, next))}
              onRemove={() => onConditions(removeCondition(conditions, idx))}
              serviceTypeNames={serviceTypeNames}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface ConditionRowProps {
  condition: FieldCondition;
  onChange: (next: FieldCondition) => void;
  onRemove: () => void;
  serviceTypeNames: readonly string[];
}

function ConditionRow({ condition, onChange, onRemove, serviceTypeNames }: ConditionRowProps) {
  const catalog = attributeCatalogForSource(condition.source);
  const showAttribute = conditionUsesAttributeKey(condition.source);
  const showValue = conditionUsesValueInput(condition.op);
  const isServiceType = condition.source === ConditionSource.SERVICE_TYPE;
  const serviceTypeListId = useId();

  // Preserve a forward-compatible unknown source/op the current build does not
  // model, rather than silently snapping the <select> to a known value on render.
  const knownSource = conditionSourceOptions.some((o) => o.source === condition.source);
  const knownOp = OP_OPTIONS.some((o) => o === condition.op);

  return (
    <li className="ktt__condition">
      <div className="ktt__condition-row">
        <label className="ktt__field ktt__field--grow">
          <span className="ktt__label">When</span>
          <select
            className="ktt__input"
            value={condition.source}
            onChange={(e) => onChange(changeConditionSource(condition, e.target.value))}
          >
            {!knownSource && <option value={condition.source}>{condition.source} (unrecognised)</option>}
            {conditionSourceOptions.map((o) => (
              <option key={o.source} value={o.source}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="ktt__field ktt__field--grow">
          <span className="ktt__label">Is</span>
          <select
            className="ktt__input"
            value={condition.op}
            onChange={(e) => onChange({ ...condition, op: e.target.value })}
          >
            {!knownOp && <option value={condition.op}>{condition.op} (unrecognised)</option>}
            {OP_OPTIONS.map((op) => (
              <option key={op} value={op}>
                {opLabel(op)}
              </option>
            ))}
          </select>
        </label>

        <IconButton icon={<TrashGlyph />} label="Remove condition" onClick={onRemove} destructive size={32} />
      </div>

      {showAttribute && (
        <label className="ktt__field">
          <span className="ktt__label">Attribute</span>
          <select
            className="ktt__input"
            value={condition.attributeKey}
            onChange={(e) => onChange({ ...condition, attributeKey: e.target.value })}
          >
            {/* A stored key not in this catalog (e.g. after a stray edit) is kept visible, not dropped. */}
            {condition.attributeKey !== '' &&
              !catalog.some((a) => a.key === condition.attributeKey) && (
                <option value={condition.attributeKey}>{condition.attributeKey} (unrecognised)</option>
              )}
            {catalog.map((a) => (
              <option key={a.key} value={a.key}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {showValue && (
        <label className="ktt__field">
          <span className="ktt__label">Value</span>
          <input
            type="text"
            className="ktt__input"
            value={condition.value}
            onChange={(e) => onChange({ ...condition, value: e.target.value })}
            placeholder={valuePlaceholder(condition.source)}
            // Suggestions only, never a hard constraint: CONTAINS matches a
            // substring, and a session may still carry a retired service-type
            // name, so this stays free text with the known catalog offered as
            // a `<datalist>` rather than a `<select>`.
            list={isServiceType && serviceTypeNames.length > 0 ? serviceTypeListId : undefined}
          />
          {isServiceType && serviceTypeNames.length > 0 && (
            <datalist id={serviceTypeListId}>
              {serviceTypeNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          )}
        </label>
      )}

      <p className="ktt__condition-summary">{conditionSummary(condition)}</p>
    </li>
  );
}

/** The four ops the editor offers, in Compose order. */
const OP_OPTIONS: readonly string[] = [
  ConditionOp.EQUALS,
  ConditionOp.NOT_EQUALS,
  ConditionOp.CONTAINS,
  ConditionOp.EXISTS,
];

// ── mood editor ──────────────────────────────────────────────────────────────

interface MoodEditorProps {
  moods: KinTaleTemplate['moodOptions'];
  onMoods: (moods: KinTaleTemplate['moodOptions']) => void;
}

/** The mood palette. A wizard step body, so it draws no panel or title of its own. */
function MoodEditor({ moods, onMoods }: MoodEditorProps) {
  const rows = sortedMoods(moods);
  return (
    <>
      <div className="ktt__step-actions">
        <GhostButton label="Add mood" onClick={() => onMoods(addMood(moods))} />
      </div>
      {rows.length === 0 ? (
        <EmptyHint>No moods yet.</EmptyHint>
      ) : (
        <ul className="ktt__moods">
          {rows.map((mood, idx) => {
            const moodLabel = mood.label.trim() || 'this mood';
            return (
              <li key={mood.key} className="ktt__mood">
                <label className="ktt__field ktt__field--emoji">
                  <span className="ktt__label">Emoji</span>
                  <input
                    type="text"
                    className="ktt__input"
                    value={mood.emoji}
                    onChange={(e) => onMoods(updateMood(moods, mood.key, { emoji: e.target.value }))}
                    placeholder="🐾"
                  />
                </label>
                <label className="ktt__field ktt__field--grow">
                  <span className="ktt__label">Mood label</span>
                  <input
                    type="text"
                    className="ktt__input"
                    value={mood.label}
                    onChange={(e) => onMoods(updateMood(moods, mood.key, { label: e.target.value }))}
                    placeholder="Happy"
                  />
                </label>
                <div className="ktt__item-actions">
                  <IconButton
                    icon={<UpGlyph />}
                    label={`Move ${moodLabel} up`}
                    onClick={() => onMoods(reorderMood(moods, mood.key, -1))}
                    disabled={idx === 0}
                    size={32}
                  />
                  <IconButton
                    icon={<DownGlyph />}
                    label={`Move ${moodLabel} down`}
                    onClick={() => onMoods(reorderMood(moods, mood.key, 1))}
                    disabled={idx === rows.length - 1}
                    size={32}
                  />
                  <IconButton
                    icon={<TrashGlyph />}
                    label={`Remove ${moodLabel}`}
                    onClick={() => onMoods(removeMood(moods, mood.key))}
                    destructive
                    size={32}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// ── glyphs (inline, matching FormSchemaEditor: no icon package here) ─────────

function UpGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 15l6-6 6 6" />
    </svg>
  );
}

function DownGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** Bookmark with a plus: "put this item in the shared bank". */
function BankGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 4H7a1 1 0 0 0-1 1v15l5-3.5 5 3.5v-7" />
      <path d="M18 3v6M15 6h6" />
    </svg>
  );
}

function TrashGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
    </svg>
  );
}
