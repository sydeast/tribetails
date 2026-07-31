import { useEffect, useState } from 'react';
import { useCollection } from '../lib/firestore';
import {
  KINTALE_TEMPLATES_QUERY,
  decodeKinTaleTemplate,
  pickInitialTemplate,
} from '../api/kinTaleTemplates';
import { saveKinTaleTemplate } from '../api/kinTaleTemplatesWrite';
import { listChecklistBank, saveChecklistBankItem } from '../api/checklistBank';
import {
  bankItemsForScope,
  normalizeBankScope,
  checklistItemFromBank,
  type ChecklistBankItem,
} from '../lib/checklistBank';
import { type ChecklistItem, type FieldCondition, type KinTaleTemplate } from '../lib/kinTale/model';
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
  serviceKeysToText,
  sortedMoods,
  textToServiceKeys,
  updateChecklistItem,
  updateCondition,
  updateMood,
  valuePlaceholder,
} from '../lib/kinTaleTemplateEdit';
import { ConditionOp } from '../lib/kinTale/model';
import { DenScreenHeading, DenPanel, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { PrimaryButton, GhostButton, IconButton } from '../components/Buttons';
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
 * One screen, list + edit together (as the Compose original is): a picker of
 * saved templates up top, the editor for the selected/new one below. Templates
 * stream live from `kintale_templates` (bounded `useCollection`); saves are
 * direct rules-backed Firestore writes (`saveKinTaleTemplate`), fail-loud.
 *
 * PORT NOTES, disclosed rather than silent:
 *  - Service types: the Compose editor has no service-type field; this port adds
 *    a comma-separated editor for `serviceTypeKeys` (per the task), the same CSV
 *    affordance `FormSchemaEditor` uses for select options.
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

export function KinTaleTemplates() {
  const stream = useCollection<Record<string, unknown>>(KINTALE_TEMPLATES_QUERY);
  const templates: KinTaleTemplate[] =
    stream.status === 'ready' ? stream.data.map(decodeKinTaleTemplate) : [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<KinTaleTemplate | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<ScreenBanner | null>(null);
  const [bank, setBank] = useState<readonly ChecklistBankItem[]>([]);

  // The shared bank, loaded once (the archive's `LaunchedEffect(Unit)`). A read
  // failure names itself in the banner rather than leaving an empty quick-add
  // row that reads as "the bank is empty".
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

  async function handleSaveToBank(text: string, scope: string) {
    const trimmed = text.trim();
    if (trimmed === '') {
      setBanner({ tone: 'error', text: 'Give the item some text before saving it to the bank.' });
      return;
    }
    try {
      await saveChecklistBankItem(trimmed, scope);
      setBank(await listChecklistBank());
      setBanner({ tone: 'success', text: `"${trimmed}" saved to the bank.` });
    } catch (err) {
      setBanner({
        tone: 'error',
        text: `Couldn't save to the bank: ${err instanceof Error ? err.message : 'unknown error'}`,
      });
    }
  }

  // Seed a sensible draft once data lands, and never again: this only fires while
  // nothing is loaded yet (`draft === null`), so a later stream tick (e.g. our
  // own save landing) never clobbers in-progress edits. Mirrors the Compose
  // editor's one-shot `LaunchedEffect(templatesRes)` default-selection.
  useEffect(() => {
    if (stream.status !== 'ready' || draft !== null) return;
    const list = stream.data.map(decodeKinTaleTemplate);
    const first = pickInitialTemplate(list);
    if (first) {
      setSelectedId(first._id);
      setDraft(first);
    } else {
      setSelectedId('');
      setDraft(seedTemplateDraft());
    }
    setDirty(false);
  }, [stream, draft]);

  function patch(p: Partial<KinTaleTemplate>) {
    setDraft((d) => (d ? { ...d, ...p } : d));
    setDirty(true);
  }

  function selectTemplate(tpl: KinTaleTemplate) {
    setSelectedId(tpl._id);
    setDraft(tpl);
    setDirty(false);
    setBanner(null);
  }

  function startNewTemplate() {
    setSelectedId('');
    setDraft(newTemplateDraft());
    setDirty(true);
    setBanner(null);
  }

  async function handleSave() {
    const d = draft;
    if (!d || saving) return;
    if (d.name.trim() === '') {
      setBanner({ tone: 'error', text: 'Give the template a name before saving.' });
      return;
    }
    setSaving(true);
    setBanner(null);
    try {
      // The streamed list doubles as the sibling set for default exclusivity, so
      // the writer needn't re-read a collection this screen is already holding.
      const id = await saveKinTaleTemplate(
        d,
        templates.map((t) => ({ _id: t._id, isDefault: t.isDefault })),
      );
      setSaving(false);
      if (id !== d._id) {
        setDraft({ ...d, _id: id });
        setSelectedId(id);
      }
      setDirty(false);
      setBanner({ tone: 'success', text: 'Template saved.' });
    } catch (err) {
      setSaving(false);
      setBanner({
        tone: 'error',
        text: `Couldn't save the template: ${err instanceof Error ? err.message : 'unknown error'}`,
      });
    }
  }

  return (
    <div className="screen kintale-templates">
      <DenScreenHeading
        kicker="The Den · KinTales"
        title="KinTale"
        accentTail="templates."
        subtitle="Shape the recap that goes home: which sections show, and the checklist Auntie fills out each visit."
        trailing={
          <div className="ktt__heading-actions">
            <span className={`ktt__status ktt__status--${dirty ? 'dirty' : 'saved'}`}>
              {dirty ? 'Unsaved changes' : 'Saved'}
            </span>
            <PrimaryButton
              label={saving ? 'Saving…' : 'Save template'}
              onClick={() => void handleSave()}
              disabled={!draft || saving}
              busy={saving}
            />
          </div>
        }
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

      {draft && (
        <TemplateEditor
          draft={draft}
          patch={patch}
          bank={bank}
          onSaveToBank={(text, scope) => void handleSaveToBank(text, scope)}
          displacesDefault={draft.isDefault && templates.some((t) => t.isDefault && t._id !== draft._id)}
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
          No templates saved yet. Start from the built-in default below and save it as your first.
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
                  {tpl.isDefault && <span className="ktt__tag ktt__tag--default">Default</span>}
                  {!tpl.isActive && <span className="ktt__tag ktt__tag--muted">Inactive</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </DenPanel>
  );
}

// ── editor body ──────────────────────────────────────────────────────────────

interface TemplateEditorProps {
  draft: KinTaleTemplate;
  patch: (p: Partial<KinTaleTemplate>) => void;
  bank: readonly ChecklistBankItem[];
  onSaveToBank: (text: string, scope: string) => void;
  /** True when saving this draft as default will clear the flag on another template. */
  displacesDefault: boolean;
}

function TemplateEditor({ draft, patch, bank, onSaveToBank, displacesDefault }: TemplateEditorProps) {
  return (
    <>
      <DenPanel title="Basic settings" subtitle="Name it, and say when it applies.">
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
            placeholder="The note that opens the recap."
            rows={3}
          />
        </label>

        <label className="ktt__field">
          <span className="ktt__label">Service types</span>
          <input
            type="text"
            className="ktt__input"
            value={serviceKeysToText(draft.serviceTypeKeys)}
            onChange={(e) => patch({ serviceTypeKeys: textToServiceKeys(e.target.value) })}
            placeholder="Comma separated, e.g. Dog Walk, Drop-in"
          />
          {/* Outside the accessible name on purpose (a hint inside <label> would join it). */}
        </label>
        <p className="ktt__note">Leave blank to let this template match any service type.</p>

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
      </DenPanel>

      <DenPanel title="Display sections" subtitle="Which blocks appear in the recap.">
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
      </DenPanel>

      {draft.checklistEnabled && (
        <>
          <ChecklistSection
            title="Per-Kin items"
            subtitle="These appear once for each Kin in the visit."
            scope="PER_PET"
            addLabel="Add per-Kin item"
            items={draft.checklistItems}
            onItems={(items) => patch({ checklistItems: items })}
            bank={bank}
            onSaveToBank={onSaveToBank}
          />
          <ChecklistSection
            title="Per-visit items"
            subtitle="These appear once for the whole visit."
            scope="PER_VISIT"
            addLabel="Add per-visit item"
            items={draft.checklistItems}
            onItems={(items) => patch({ checklistItems: items })}
            bank={bank}
            onSaveToBank={onSaveToBank}
          />
        </>
      )}

      {draft.petMoodEnabled && (
        <MoodEditor moods={draft.moodOptions} onMoods={(moods) => patch({ moodOptions: moods })} />
      )}
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
  title: string;
  subtitle: string;
  scope: string;
  addLabel: string;
  items: ChecklistItem[];
  onItems: (items: ChecklistItem[]) => void;
  bank: readonly ChecklistBankItem[];
  onSaveToBank: (text: string, scope: string) => void;
}

function ChecklistSection({
  title,
  subtitle,
  scope,
  addLabel,
  items,
  onItems,
  bank,
  onSaveToBank,
}: ChecklistSectionProps) {
  const rows = scope === 'PER_PET' ? perPetItems(items) : perVisitItems(items);
  return (
    <DenPanel
      title={title}
      subtitle={subtitle}
      trailing={<GhostButton label={addLabel} onClick={() => onItems(addChecklistItem(items, scope))} />}
    >
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
              onSaveToBank={onSaveToBank}
            />
          ))}
        </ul>
      )}
      <BankAddRow bank={bank} items={items} scope={scope} onItems={onItems} />
    </DenPanel>
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
  onSaveToBank: (text: string, scope: string) => void;
}

function ChecklistItemCard({ item, items, isFirst, isLast, onItems, onSaveToBank }: ChecklistItemCardProps) {
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

      <ConditionsEditor conditions={item.conditions} onConditions={setConditions} />
    </li>
  );
}

// ── conditions editor (the I7 payload) ───────────────────────────────────────

interface ConditionsEditorProps {
  conditions: FieldCondition[];
  onConditions: (conditions: FieldCondition[]) => void;
}

function ConditionsEditor({ conditions, onConditions }: ConditionsEditorProps) {
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
}

function ConditionRow({ condition, onChange, onRemove }: ConditionRowProps) {
  const catalog = attributeCatalogForSource(condition.source);
  const showAttribute = conditionUsesAttributeKey(condition.source);
  const showValue = conditionUsesValueInput(condition.op);

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
          />
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

function MoodEditor({ moods, onMoods }: MoodEditorProps) {
  const rows = sortedMoods(moods);
  return (
    <DenPanel
      title="Mood options"
      subtitle="The palette Auntie tags each Kin's mood from."
      trailing={<GhostButton label="Add mood" onClick={() => onMoods(addMood(moods))} />}
    >
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
    </DenPanel>
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
