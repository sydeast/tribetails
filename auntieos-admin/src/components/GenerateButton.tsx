import { useState } from 'react';
import { GhostButton } from './Buttons';
import { generateDraft, draftOpening, type GenerateCommunicationType } from '../api/communicateGenerate';
import './GenerateButton.css';

export interface GeneratedDraft {
  body: string;
  /** Blank when no title was asked for, or when the title call failed. */
  title: string;
  draftWriteFailed: boolean;
}

interface Props {
  communicationType: GenerateCommunicationType;
  /** Free-text Kinfolk name. Blank is legal now: the backend treats it as "no household context". */
  recipient: string;
  /** The operator's own notes. Auntie needs something to work from. */
  rawNotes: string;
  /** Ask for a headline too. Only set it if there is somewhere to put one. */
  wantTitle?: boolean;
  /** The current body, if any. Its opening is fed back so a regenerate varies. */
  currentBody?: string;
  onGenerated: (draft: GeneratedDraft) => void;
  /** Failures go to the caller's persistent surface, never to a toast. */
  onError: (message: string) => void;
  disabled?: boolean;
}

/**
 * "Ask Auntie" beside a compose box.
 *
 * The generator is a DRAFT tool. It never sends: `generateAuntieCopy` returns
 * copy and writes a `generated_drafts` row, and it has no Twilio or SendGrid
 * path at all (verified by grep, 2026-07-20). So this button is safe to sit next
 * to a send button without a confirmation step.
 *
 * It owns only its own in-flight state. The generated text belongs to the form,
 * so the caller decides what to do with it, which is what lets the same button
 * serve the KinTale composer, Communicate, and anything added later.
 */
export function GenerateButton({
  communicationType,
  recipient,
  rawNotes,
  wantTitle = false,
  currentBody = '',
  onGenerated,
  onError,
  disabled = false,
}: Props) {
  const [generating, setGenerating] = useState(false);

  // Regenerate rather than first draft: there is already a body to vary from.
  const isRegenerate = currentBody.trim() !== '';
  const notesReady = rawNotes.trim() !== '';

  async function handleClick() {
    if (!notesReady) {
      // Not an error state, a precondition. Say what to do, do not just disable
      // and leave the operator guessing which field is empty.
      onError('Jot a few notes first so Auntie has something to work with.');
      return;
    }

    setGenerating(true);
    try {
      const result = await generateDraft({
        communication_type: communicationType,
        recipient,
        raw_notes: rawNotes.trim(),
        ...(wantTitle ? { want_title: true } : {}),
        ...(isRegenerate ? { avoid_opening: draftOpening(currentBody) } : {}),
      });
      onGenerated({
        body: result.generated_copy,
        title: result.generated_title,
        draftWriteFailed: result.draftWriteFailed,
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Auntie could not draft that.');
    } finally {
      setGenerating(false);
    }
  }

  return (
    <GhostButton
      label={generating ? 'Auntie is writing…' : isRegenerate ? 'Ask Auntie again' : 'Ask Auntie'}
      onClick={() => void handleClick()}
      disabled={disabled || generating}
      className="generate-button"
    />
  );
}
