/**
 * Does a service address look too thin to drive to? (#1602)
 *
 * On the 2026-11-05 walk Dre East's address was stored as "18605", and the
 * visit and the Auntie Time map chip showed just that with nothing saying it
 * was incomplete. An Auntie handed "18605" cannot find the door.
 *
 * Deliberately simple, and deliberately only a HINT: it never blocks a save or
 * hides the address. An address reads as incomplete when it has no letters at
 * all (a bare number or ZIP), or has fewer than three words and no comma (no
 * street name and town). "18605" and "Main St" are incomplete; "18605 Oak Lane,
 * Austin TX" and "12 Rue Cler, Paris" are not. Mirrored by Android
 * `AddressCompleteness.kt`.
 */
export const INCOMPLETE_ADDRESS_HINT = 'This address looks incomplete. Fix it on the household profile.';

export function addressLooksIncomplete(raw: string): boolean {
  const address = raw.trim();
  if (address === '') return false;
  if (!/\p{L}/u.test(address)) return true;
  const words = address.split(/\s+/).filter((w) => w !== '');
  return words.length < 3 && !address.includes(',');
}
