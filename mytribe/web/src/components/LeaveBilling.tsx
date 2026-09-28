import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';

/**
 * #1005: rendered in place of a billing screen when the server refused the
 * caller billing access. Goes back to Home with no message: a member without
 * billing access is not in an error state, there is just nothing here for them.
 */
export function LeaveBilling() {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ to: '/home', replace: true });
  }, [navigate]);
  return null;
}
