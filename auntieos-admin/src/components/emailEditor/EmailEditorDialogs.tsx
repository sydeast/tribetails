import { useState } from 'react';
import { Dialog } from '../Dialog';
import { GhostButton, PrimaryButton } from '../Buttons';
import { LoadingRow } from '../LoadingRow';
import { fieldNameOf, normalizeWebTarget } from '../../lib/emailContent';
import { emailImageFileError, uploadEmailImage } from '../../api/emailImageUpload';
import type { UploadStage } from '../../api/mediaUpload';

export interface TargetValue {
  label: string;
  href: string;
}

export interface TargetDialogProps {
  title: string;
  /** True for a button, which needs its own text. A link wraps the selected text instead. */
  withLabel: boolean;
  /** Links may send an email; buttons may not. */
  allowMailto: boolean;
  fields: readonly string[];
  initial: TargetValue;
  onSubmit: (value: TargetValue) => void;
  onRemove?: (() => void) | undefined;
  onClose: () => void;
}

export function TargetDialog({ title, withLabel, allowMailto, fields, initial, onSubmit, onRemove, onClose }: TargetDialogProps) {
  const initialField = fieldNameOf(initial.href);
  const options = initialField && !fields.includes(initialField) ? [initialField, ...fields] : [...fields];
  const [label, setLabel] = useState(initial.label);
  const [kind, setKind] = useState<'web' | 'field'>(initialField ? 'field' : 'web');
  const [web, setWeb] = useState(initialField ? '' : initial.href);
  const [field, setField] = useState(initialField ?? options[0] ?? '');
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (withLabel && label.trim() === '') {
      setError('Type the button text.');
      return;
    }
    const href = kind === 'field' ? (field ? `{{${field}}}` : null) : normalizeWebTarget(web, allowMailto);
    if (href === null) {
      setError(
        kind === 'field'
          ? 'Pick a field.'
          : allowMailto
            ? 'Type a web address starting with https://, or an email address.'
            : 'Type a web address starting with https://.',
      );
      return;
    }
    onSubmit({ label: label.trim(), href });
  }

  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          {onRemove ? <GhostButton label="Remove link" onClick={onRemove} /> : null}
          <GhostButton label="Cancel" onClick={onClose} />
          <PrimaryButton label="Done" onClick={submit} />
        </>
      }
    >
      {error ? (
        <p className="email-editor__error" role="alert">
          {error}
        </p>
      ) : null}
      {withLabel ? (
        <label className="email-editor__dlabel">
          Button text
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
        </label>
      ) : null}
      <fieldset className="email-editor__target">
        <legend>Goes to</legend>
        <label>
          <input type="radio" name="email-target-kind" checked={kind === 'web'} onChange={() => setKind('web')} /> A web
          address
        </label>
        <label>
          <input
            type="radio"
            name="email-target-kind"
            checked={kind === 'field'}
            disabled={options.length === 0}
            onChange={() => setKind('field')}
          />{' '}
          A merge field
        </label>
        {kind === 'web' ? (
          <label className="email-editor__dlabel">
            Address
            <input
              type="text"
              inputMode="url"
              value={web}
              onChange={(e) => setWeb(e.target.value)}
              placeholder="https://tribetails.com"
            />
          </label>
        ) : (
          <label className="email-editor__dlabel">
            Field
            <select value={field} onChange={(e) => setField(e.target.value)}>
              {options.map((name) => (
                <option key={name} value={name}>{`{{${name}}}`}</option>
              ))}
            </select>
          </label>
        )}
      </fieldset>
    </Dialog>
  );
}

const STAGE_LABEL: Record<UploadStage, string> = {
  signing: 'Getting ready to upload…',
  uploading: 'Uploading image…',
  saving: 'Adding it to the gallery…',
};

export interface ImageDialogProps {
  onInsert: (img: { src: string; alt: string }) => void;
  onClose: () => void;
}

/**
 * #953 ruling C9: the server refuses a merge token in any attribute other
 * than `href` -- "A merge field can only be used in text or as a link
 * target." An `alt` carrying `{{` is always going to be rejected on Save (or
 * on Convert/Preview), so this is refused before the upload even starts,
 * the same way an oversized or non-image file is.
 */
function altTextError(alt: string): string | null {
  if (alt.trim() === '') return 'Describe the image in a few words.';
  if (alt.includes('{{')) return "Merge fields can't go in an image description.";
  return null;
}

export function ImageDialog({ onInsert, onClose }: ImageDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState('');
  const [stage, setStage] = useState<UploadStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = stage !== null;

  function pick(next: File | null) {
    setFile(next);
    setError(next ? emailImageFileError(next) : null);
  }

  async function upload() {
    if (!file) {
      setError('Pick an image first.');
      return;
    }
    const problem = emailImageFileError(file);
    if (problem) {
      setError(problem);
      return;
    }
    const altProblem = altTextError(alt);
    if (altProblem) {
      setError(altProblem);
      return;
    }
    setError(null);
    setStage('signing');
    try {
      const src = await uploadEmailImage(file, setStage);
      onInsert({ src, alt: alt.trim() });
    } catch (err) {
      setStage(null);
      setError(`The upload didn’t finish: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }

  return (
    <Dialog
      title="Image"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={busy} />
          <PrimaryButton label={busy ? 'Uploading…' : 'Upload and insert'} onClick={() => void upload()} disabled={busy} busy={busy} />
        </>
      }
    >
      {error ? (
        <p className="email-editor__error" role="alert">
          {error}
        </p>
      ) : null}
      <label className="email-editor__dlabel">
        Image file
        <input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          disabled={busy}
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
        />
      </label>
      <label className="email-editor__dlabel">
        Description
        <input
          type="text"
          value={alt}
          onChange={(e) => setAlt(e.target.value)}
          maxLength={200}
          disabled={busy}
          placeholder="Two dogs on a walk"
        />
      </label>
      {stage ? <LoadingRow label={STAGE_LABEL[stage]} /> : null}
    </Dialog>
  );
}

export interface FieldDialogProps {
  fields: readonly string[];
  state: 'loading' | 'ready' | 'error';
  note: string | undefined;
  onPick: (name: string) => void;
  onClose: () => void;
}

/**
 * #953 carry-forward: a field name local to an `{{#each}}` loop body
 * (`this`, `this.weekday`) must never be offered here, whatever the caller
 * passes in -- `fieldsForTemplate`'s own-tokens fallback already filters
 * these at the source, and this is the belt to that braces so the dialog
 * itself can never regress the guarantee.
 */
function isLoopScopedToken(name: string): boolean {
  return name === 'this' || name.startsWith('this.');
}

export function FieldDialog({ fields, state, note, onPick, onClose }: FieldDialogProps) {
  const offered = fields.filter((name) => !isLoopScopedToken(name));
  return (
    <Dialog title="Insert field" onClose={onClose} footer={<GhostButton label="Cancel" onClick={onClose} />}>
      {state === 'loading' ? <LoadingRow label="Loading fields…" /> : null}
      {state === 'error' ? (
        <p className="email-editor__error" role="alert">
          Couldn’t load this template’s fields. These are the fields it already uses.
        </p>
      ) : null}
      {note ? <p className="email-editor__note">{note}</p> : null}
      {state !== 'loading' && offered.length === 0 ? <p className="email-editor__note">There are no fields to insert.</p> : null}
      <div className="email-editor__fields" role="group" aria-label="Fields">
        {offered.map((name) => (
          <button key={name} type="button" className="email-editor__field" onClick={() => onPick(name)}>
            {`{{${name}}}`}
          </button>
        ))}
      </div>
    </Dialog>
  );
}
