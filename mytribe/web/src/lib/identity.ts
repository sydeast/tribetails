import { useQuery } from '@tanstack/react-query';
import { getMyAccount, type AccountDto } from '../api/accountApi';
import { getMyHome } from '../api/portal';
import { useAuth } from './auth';
import { getActiveKinfolkId } from './activeTribe';
/**
 * Who the header and the greetings say is signed in (#1290).
 *
 * One source, used by every screen: the person's own display name from their
 * account, else the address they sign in with. Before this, Home and Tribe fed
 * the nav the HOUSEHOLD's name (initial "T", greeting "Hi TEST SANDBOX") while
 * every other screen fed it nothing and fell back to the email ("C"), and
 * Account computed a third answer. Same person, three letters.
 *
 * An operator who stepped into another household is looking at that household,
 * not at themselves, so they get the household's name instead.
 */
export interface Identity {
  /** Full name as it should read in a heading, or '' when nothing is known. */
  name: string;
  /** First word of the name in sentence case, or '' when nothing is known. */
  firstName: string;
  /** One letter for the avatar. Never empty. */
  initial: string;
}
const FALLBACK_INITIAL = 'M';
/** "TEST" and "casey" both read as shouted or unfinished; "Casey QA" is left alone. */
function sentenceCase(word: string): string {
  if (word === '') return '';
  const shouted = word === word.toUpperCase();
  const flat = word === word.toLowerCase();
  if (!shouted && !flat) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}
function firstWord(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}
/** "casey.qa+test@example.com" -> "casey". */
function emailGivenName(email: string): string {
  const local = email.split('@')[0] ?? '';
  return local.split(/[._+\-\d]+/).find((part) => part !== '') ?? '';
}
function initialOf(name: string): string {
  const first = Array.from(name).find((ch) => /[\p{L}\p{N}]/u.test(ch));
  return first ? first.toUpperCase() : FALLBACK_INITIAL;
}
export function resolveIdentity(input: {
  account: Pick<AccountDto, 'displayName' | 'email' | 'impersonated'> | undefined;
  signInEmail?: string | null | undefined;
  householdName?: string | null | undefined;
}): Identity {
  const { account } = input;
  const email = (account && !account.impersonated ? account.email : null) ?? input.signInEmail ?? '';
  const own = (account?.displayName ?? '').trim();
  // Older accounts were seeded with displayName = email; that is not a name.
  const savedName = own !== '' && own.toLowerCase() !== email.trim().toLowerCase() ? own : '';
  const household = (input.householdName ?? '').trim();
  let name: string;
  let given: string;
  if (account?.impersonated) {
    name = household;
    given = firstWord(household);
  } else if (savedName !== '') {
    name = savedName;
    given = firstWord(savedName);
  } else if (email.trim() !== '') {
    name = email.trim();
    given = emailGivenName(email.trim());
  } else {
    name = '';
    given = '';
  }
  return { name, firstName: sentenceCase(given), initial: initialOf(name) };
}
/**
 * The signed-in person's identity for the current household. Reads the same two
 * cached queries Account and Home already own (same keys), so on those screens
 * it costs nothing and elsewhere it is one account read, cached for five
 * minutes. A failed read is not an error state here: the header without a saved
 * name is the email's initial, which is the shipped fallback.
 */
export function usePortalIdentity(): Identity & { settled: boolean } {
  const authState = useAuth();
  const kinfolkId = getActiveKinfolkId();
  const account = useQuery({
    queryKey: ['myAccount', kinfolkId],
    queryFn: () => getMyAccount(kinfolkId),
    staleTime: 5 * 60_000,
  });
  const home = useQuery({
    queryKey: ['myHome', kinfolkId],
    queryFn: () => getMyHome(kinfolkId),
    staleTime: 5 * 60_000,
  });
  const signInEmail = authState.status === 'signedIn' ? authState.user.email : null;
  const identity = resolveIdentity({ account: account.data, signInEmail, householdName: home.data?.displayName });
  return { ...identity, settled: !account.isPending };
}
