/**
 * A Google Maps "directions to" link for a plain address string.
 *
 * Shared by the kinfolk profile's service address and `HouseholdVetPanels`'
 * clinic addresses (issue #685): the operator taps an address expecting a
 * route there, the same way `tel:` and `sms:` already open the phone and
 * messaging apps for a phone number.
 */
export function directionsHref(address: string): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
}
