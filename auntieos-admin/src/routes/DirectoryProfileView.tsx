import { useNavigate, useParams } from '@tanstack/react-router';
import { Directory } from '../screens/Directory';

/**
 * Deep link to ONE household's profile, `/directory/{kinfolkId}`.
 *
 * Directory already owns the profile as a sibling view of its list; this route
 * just opens the list on that view, and closing it navigates back to the bare
 * list so the URL and the screen never disagree. Added for the Schedule detail
 * sheet's kinfolk link (operator issue 16), which needs somewhere real to
 * point: a link to a route that does not exist is worse than no link.
 */
export function DirectoryProfileView() {
  const { kinfolkId } = useParams({ from: '/admin/directory/$kinfolkId' });
  const navigate = useNavigate();
  return (
    <Directory
      initialKinfolkId={kinfolkId}
      onProfileClose={() => void navigate({ to: '/directory' })}
    />
  );
}
