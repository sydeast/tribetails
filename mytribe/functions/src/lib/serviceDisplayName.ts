import { kinCareLengthMinutes, prettifyRateKey } from '../portal/getServiceCatalog';

/**
 * WHAT A VISIT'S SERVICE IS CALLED, for the household (#1297, #1288).
 *
 * `serviceType` on `kin_care_sessions` and `families/{id}/bookings/{b}/kinCares`
 * is free text, and the live collections hold codes and near-codes for the same
 * handful of services: `visit_60`, `60Mins`, `30 Minute`, `30Minute`. The portal
 * printed them raw, so a household read "SERVICE TYPE · VISIT_60" on its
 * schedule and "VISIT_60" as an invoice line.
 *
 * THE NAME IS BUSINESS DATA. It comes from the operator's own KinCare list,
 * `business_settings.serviceRates` (name -> rate) plus `serviceDurations`, the
 * same map `getServiceCatalog` turns into the booking wizard's service names.
 * The name returned here is that catalog's `name` for the matched entry
 * (`prettifyRateKey` of the key), so a visit on the schedule, its invoice line
 * and the service the household picked when booking all read the same.
 *
 * Resolution, in order. This is the portal port of the admin app's
 * `bookingServiceName` (auntieos-admin/src/lib/bookingFormat.ts), so both apps
 * resolve a raw label to the same catalog entry:
 *   1. The catalog key itself, matched on letters and digits alone, so
 *      `30 Minute` and `30Minute` both land on the configured `30Minute`.
 *   2. The one catalog entry that runs for the length the label states, when
 *      exactly one does. That reaches `visit_60` and `60Mins`. Two 60-minute
 *      KinCares resolve to nothing rather than to a guess.
 *   3. The visit's own stored `serviceName`, when the writer kept one.
 *   4. The raw label, unless it is a code (`visit_60`, `VISIT_60`): a service
 *      the operator renamed still says what it was booked as, but an
 *      identifier is not a name and is never shown.
 *
 * Null only when there is nothing to show; each client then uses the word it
 * already uses for an unnamed visit.
 */
export interface ServiceNameCatalog {
  serviceRates: Record<string, unknown>;
  serviceDurations: unknown;
}

export const EMPTY_SERVICE_NAME_CATALOG: ServiceNameCatalog = { serviceRates: {}, serviceDurations: {} };

/** The two settings maps off `business_settings/business_settings`, read defensively. */
export function serviceNameCatalogFrom(settings: Record<string, unknown> | undefined | null): ServiceNameCatalog {
  const rates = settings?.['serviceRates'];
  return {
    serviceRates: rates && typeof rates === 'object' && !Array.isArray(rates) ? (rates as Record<string, unknown>) : {},
    serviceDurations: settings?.['serviceDurations'] ?? {},
  };
}

/** Letters and digits only, lowercased: "30 Minute", "30Minute" and "30-minute" are one id. */
function normaliseServiceKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Minutes a raw label states, for catalog matching only. A stated unit wins
 * ("60Mins", "30 Minute", "2Hrs"); failing that a BARE trailing number is read
 * as minutes, which is the `visit_60` shape. Never decides a name alone: see
 * step 2 above.
 */
function labelMinutes(label: string): number | null {
  const unit = /(\d{1,4})\s*(min|mins|minute|minutes|hr|hrs|hour|hours)\b/i.exec(label);
  if (unit) {
    const n = Number(unit[1]);
    return /^h/i.test(unit[2]) ? n * 60 : n;
  }
  const bare = /(?:^|[^0-9A-Za-z])(\d{1,4})$/.exec(label);
  if (!bare) return null;
  const minutes = Number(bare[1]);
  return minutes > 0 ? minutes : null;
}

/**
 * True for an identifier rather than a name: one word joined by underscores
 * (`visit_60`, `VISIT_60`, `overnight_care`). A label with a space is a name
 * somebody typed, and is kept.
 */
export function looksLikeServiceCode(label: string): boolean {
  return /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/.test(label.trim());
}

export function serviceDisplayName(
  rawServiceType: unknown,
  catalog: ServiceNameCatalog,
  storedServiceName?: unknown,
): string | null {
  const label = typeof rawServiceType === 'string' ? rawServiceType.trim() : '';
  const stored = typeof storedServiceName === 'string' ? storedServiceName.trim() : '';
  if (label !== '') {
    const keys = Object.keys(catalog.serviceRates)
      .map((key) => key.trim())
      .filter((key) => key !== '');
    const wanted = normaliseServiceKey(label);
    const exact = keys.find((key) => normaliseServiceKey(key) === wanted);
    if (exact !== undefined) return prettifyRateKey(exact);
    const minutes = labelMinutes(label);
    if (minutes !== null) {
      const sameLength = keys.filter((key) => kinCareLengthMinutes(key, catalog.serviceDurations) === minutes);
      if (sameLength.length === 1) return prettifyRateKey(sameLength[0]);
    }
  }
  if (stored !== '' && !looksLikeServiceCode(stored)) return stored;
  if (label !== '' && !looksLikeServiceCode(label)) return label;
  return null;
}
