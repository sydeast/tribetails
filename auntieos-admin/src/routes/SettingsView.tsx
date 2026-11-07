import { useNavigate, useSearch } from '@tanstack/react-router';
import { Settings } from '../screens/Settings';

/**
 * Adapts `/settings?section=<id>` to Settings' props, the same one-line
 * convention `BookingsView` and `InvoicesView` use for their own search
 * params.
 *
 * `?section=` started as the landing spot of the retired `/notification-gate`
 * redirect (#718). Since #1594 it is also where the open section lives: a
 * section change writes it, so a reload, a bookmark or a pasted link opens
 * the same section instead of Business profile. The write REPLACES the entry
 * rather than pushing one: arrow keys move through sections, and Back should
 * leave Settings, not replay every section the focus passed over.
 */
export function SettingsView() {
  const { section } = useSearch({ from: '/admin/settings' });
  const navigate = useNavigate();
  return (
    <Settings
      {...(section ? { initialSection: section } : {})}
      onSectionChange={(id) => void navigate({ to: '/settings', search: { section: id }, replace: true })}
    />
  );
}
