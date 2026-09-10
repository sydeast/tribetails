import { useSearch } from '@tanstack/react-router';
import { Settings } from '../screens/Settings';

/**
 * Adapts `/settings?section=<id>` to Settings' props, the same one-line
 * convention `BookingsView` and `InvoicesView` use for their own search
 * params.
 *
 * The only caller of `?section=` today is the redirect `/notification-gate`
 * now issues (#718): the operator wants exactly one way to the notification
 * gate, the Notifications section under Settings, so the retired standalone
 * route lands here instead of a plain, unfocused `/settings`.
 */
export function SettingsView() {
  const { section } = useSearch({ from: '/admin/settings' });
  return <Settings {...(section ? { initialSection: section } : {})} />;
}
