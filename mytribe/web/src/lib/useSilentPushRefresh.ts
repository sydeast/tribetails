import { useEffect } from 'react';
/**
 * #1787: a returning session can land on any signed-in screen, not only Home.
 * When the browser has already allowed notifications, register this device
 * quietly so its token stays fresh and the foreground message handler is
 * installed. The push module is loaded only in that case, and the attempt is
 * memoised per sign-in inside it, so every screen can call this for free.
 * Failures are shown by the notifications card on Home and in Notification
 * Settings, which is where the kinfolk can retry.
 */
export function useSilentPushRefresh(): void {
  useEffect(() => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    void import('./push').then(({ refreshPushRegistration }) => refreshPushRegistration()).catch(() => undefined);
  }, []);
}
