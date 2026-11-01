/**
 * #1297: THE ONE PLACE A SCREEN ASKS WHAT A VISIT'S SERVICE IS CALLED.
 *
 * The name is resolved on the server against the operator's KinCare list
 * (`mytribe/functions/src/lib/serviceDisplayName.ts`) and arrives as
 * `serviceLabel` on `getMyBookings` and `getMyVisits` rows. Screens never print
 * `serviceType`, which is the stored value and is often a code (`visit_60`).
 *
 * DEPLOY SKEW. Web and functions do not deploy together, so a row from a server
 * that predates `serviceLabel` has no such key. Then the raw value is used only
 * when it reads as a name; a code is never shown, and the caller falls back to
 * its own word for a visit.
 */
export interface ServiceLabelled {
  serviceLabel?: string | null;
  serviceType?: string | null;
}

/** True for an identifier rather than a name: `visit_60`, `VISIT_60`. Mirrors the server rule. */
export function looksLikeServiceCode(label: string): boolean {
  return /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/.test(label.trim());
}

export function serviceLabelOf(row: ServiceLabelled | null | undefined): string | null {
  if (!row) return null;
  if (row.serviceLabel !== undefined) {
    const named = (row.serviceLabel ?? '').trim();
    return named === '' ? null : named;
  }
  const raw = (row.serviceType ?? '').trim();
  return raw === '' || looksLikeServiceCode(raw) ? null : raw;
}

/**
 * A row's title: its own `title`, else the service name. A title that is
 * itself a code (an older server copied `serviceType` into it) is treated as
 * no title.
 */
export function visitTitleOf(row: (ServiceLabelled & { title?: string | null }) | null | undefined): string | null {
  const title = (row?.title ?? '').trim();
  if (title !== '' && !looksLikeServiceCode(title)) return title;
  return serviceLabelOf(row);
}

/**
 * The small line above a visit's title. The service name, shown only when it
 * says something the title does not; no "Service Type ·" prefix.
 */
export function serviceEyebrowOf(row: (ServiceLabelled & { title?: string | null }) | null | undefined): string | null {
  const label = serviceLabelOf(row);
  const title = visitTitleOf(row);
  return label !== null && title !== null && label !== title ? label : null;
}
