import { useState } from 'react';
import { GhostButton, PrimaryButton } from './Buttons';
import { Dialog } from './Dialog';
import { Banner } from './Banner';
import { useToast } from './Toast';
import { deleteKinTaleReportDraft } from '../api/kinTaleReportDraftDelete';

interface DeleteKinTaleDraftButtonProps {
  /** The bare `kin_care_reports` id of an unsent draft. */
  reportId: string;
  /** The household the draft is for, named in the confirm. Blank reads generically. */
  household: string;
  /** Called after the server has deleted it. The caller leaves the screen. */
  onDeleted: () => void;
  disabled?: boolean;
}

/**
 * #1631: "Delete draft" plus its confirm, for an unsent KinTale report draft.
 * Shared by the report detail and the composer so both ask the same question
 * and call the same callable. The caller decides whether to render it
 * (`canDeleteKinTaleDraft`).
 */
export function DeleteKinTaleDraftButton({ reportId, household, onDeleted, disabled }: DeleteKinTaleDraftButtonProps) {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runDelete() {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteKinTaleReportDraft(reportId);
      setDeleting(false);
      setOpen(false);
      // A toast, not local state: the caller unmounts this on `onDeleted`.
      showToast('Draft deleted.');
      onDeleted();
    } catch (err) {
      setDeleting(false);
      setError(err instanceof Error ? err.message : 'Delete failed.');
    }
  }

  const who = household.trim();
  return (
    <>
      <GhostButton
        label="Delete draft"
        disabled={disabled === true || deleting}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      />
      {open && (
        <Dialog
          title="Delete this draft?"
          onClose={() => {
            if (!deleting) setOpen(false);
          }}
          footer={
            <>
              <GhostButton label="Cancel" onClick={() => setOpen(false)} disabled={deleting} />
              <PrimaryButton
                label={deleting ? 'Deleting…' : 'Delete'}
                onClick={() => void runDelete()}
                disabled={deleting}
                busy={deleting}
              />
            </>
          }
        >
          <p>
            {who !== '' ? `This KinTale for ${who} has not been sent.` : 'This KinTale has not been sent.'} Deleting
            it cannot be undone.
          </p>
          {error !== null && <Banner tone="error">{error}</Banner>}
        </Dialog>
      )}
    </>
  );
}
