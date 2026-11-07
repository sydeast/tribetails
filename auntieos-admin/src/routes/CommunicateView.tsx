import { useNavigate, useSearch } from '@tanstack/react-router';
import { Communicate } from '../screens/Communicate';

/**
 * The `/communicate` route. Reads `?draftId=` (#1563), the stored KinTale draft
 * KinTales > Drafts or Home's "KinTales pending" sent the operator here to
 * review, and hands it to the screen. The screen itself stays router-free so
 * its tests render it bare.
 */
export function CommunicateView() {
  const { draftId } = useSearch({ from: '/admin/communicate' });
  const navigate = useNavigate();
  return (
    <Communicate
      draftId={draftId}
      onOpenKinTale={(reportId) => void navigate({ to: '/kintales', search: { kinTaleId: reportId } })}
    />
  );
}
