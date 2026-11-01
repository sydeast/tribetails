import { useQuery } from '@tanstack/react-query';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { getMyHome } from '../api/portal';
/**
 * The operator's business name, from business settings (#1369).
 *
 * Reads `getMyHome.businessName` through the SAME `['myHome', kinfolkId]` cache
 * `PortalNav` keeps warm on every screen, so this costs no extra callable on the
 * common path. Returns '' while loading, on failure, and when the operator has
 * not set a name. A failure is silent on purpose, for the reason PortalNav
 * documents: a missing footer line is not a degraded state worth a banner.
 *
 * Callers must not substitute a name of their own. An unset name means the
 * footnote is left out, never a hard-coded business.
 */
export function useBusinessName(): string {
  const kinfolkId = getActiveKinfolkId();
  const home = useQuery({
    queryKey: ['myHome', kinfolkId],
    queryFn: () => getMyHome(kinfolkId),
    staleTime: 5 * 60_000,
  });
  return (home.data?.businessName ?? '').trim();
}
/**
 * The business name for a sentence, read from the `['myHome', kinfolkId]` cache
 * WITHOUT fetching (#1381). For shared pieces that render on pre-auth screens as
 * well (the slow-wait cue, the offline card): they must not fire a tenant read of
 * their own, and a cold cache just means the neutral "your Auntie" wording.
 */
export function useCachedBusinessName(): string {
  const kinfolkId = getActiveKinfolkId();
  const home = useQuery({
    queryKey: ['myHome', kinfolkId],
    queryFn: () => getMyHome(kinfolkId),
    staleTime: 5 * 60_000,
    enabled: false,
  });
  return (home.data?.businessName ?? '').trim();
}
/**
 * The page footnote, "Cared for by <business>" (or "Billed by <business>" on an
 * invoice). Renders nothing when [name] is empty or absent.
 *
 * Takes the name as a prop so a screen that already holds it (Home, Account, the
 * invoice's business contact) adds no second observer.
 */
export function BusinessFootnote(props: { lead?: string; name: string | undefined }) {
  const name = (props.name ?? '').trim();
  if (name === '') return null;
  return (
    <p className="footnote">
      {props.lead ?? 'Cared for by'} <b>{name}</b>
    </p>
  );
}
/** [BusinessFootnote] for a screen that holds no business name itself. */
export function SettingsBusinessFootnote(props: { lead?: string }) {
  const name = useBusinessName();
  return props.lead === undefined ? <BusinessFootnote name={name} /> : <BusinessFootnote lead={props.lead} name={name} />;
}
