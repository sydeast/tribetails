/**
 * The household `joinDate` field: one calendar day, stored as `YYYY-MM-DD`.
 *
 * It was a free text box on both surfaces, so the collection holds whatever was
 * typed or written into it over the years. Two shapes are known to exist:
 *
 *  - full ISO instants, `2026-07-24T12:34:56.789Z`, which is what
 *    `mytribe/scripts/seedDemoKinfolk.ts` writes (`Date.toISOString()`), and what
 *    the operator was seeing printed raw on the profile
 *  - anything a person typed into Android's `AuntieField`, `07/24/2026` and worse
 *
 * There is no migration. These helpers are the whole tolerance story, split by
 * surface because the two surfaces owe the operator different things:
 *
 *  - DISPLAY ([formatJoinDate]) never fails and never guesses. A value it can
 *    read is formatted; a value it cannot is printed exactly as stored. Better a
 *    scruffy date than "Invalid Date", and far better than either is not throwing
 *    inside a profile render.
 *  - EDIT ([joinDateForEdit]) has to hand `<input type="date">` a value it can
 *    actually show, and the editor's schema now rejects everything else. So the
 *    coercion happens once, at load, and anything it cannot coerce comes back as
 *    blank WITH a note naming the stored value, so the operator can replace it.
 *    Without that note the field would silently read empty and the original
 *    string would vanish on the next save.
 *
 * Deliberately NOT parsed: `07/24/2026`, `24/07/2026`, and friends. Month-first
 * and day-first are indistinguishable for the first twelve days of any month, so
 * reading them means being wrong about some households without knowing which. A
 * date nobody can verify is worse than a blank the operator is asked to fill.
 */

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a `YYYY-MM-DD` string that names a day that actually exists. */
export function isIsoDate(raw: string): boolean {
  if (!ISO_DAY_RE.test(raw)) return false;
  return parseIsoDay(raw) !== null;
}

/**
 * `YYYY-MM-DD` to a Date at LOCAL midnight, or null when the day is not real
 * (`2026-02-30`, `2026-13-01`).
 *
 * Local, not UTC, and that is the whole point: `new Date('2026-01-01')` is
 * midnight UTC, which every operator west of Greenwich sees rendered as
 * December 31. Building from the parts pins the date to the day it names.
 */
function parseIsoDay(iso: string): Date | null {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const d = new Date(year, month - 1, day);
  // Rollover check: `new Date(2026, 1, 30)` happily becomes March 2.
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

/** The ISO day at the head of a stored value, or null when there isn't one. */
function isoDayPrefix(raw: string): string | null {
  const trimmed = raw.trim();
  const head = trimmed.slice(0, 10);
  if (!isIsoDate(head)) return null;
  // Either the value IS the day, or the day is followed by a time separator.
  if (trimmed.length === 10) return head;
  const next = trimmed.charAt(10);
  return next === 'T' || next === ' ' ? head : null;
}

export interface JoinDateForEdit {
  /** What the date input should hold: an ISO day, or blank. */
  value: string;
  /** What the operator needs told about a stored value that isn't that, else null. */
  note: string | null;
}

/** Open a stored join date in the editor: coerce what is readable, disclose the rest. */
export function joinDateForEdit(raw: string): JoinDateForEdit {
  const trimmed = raw.trim();
  if (trimmed === '') return { value: '', note: null };
  if (isIsoDate(trimmed)) return { value: trimmed, note: null };

  const day = isoDayPrefix(trimmed);
  if (day !== null) {
    return {
      value: day,
      note: `Stored as “${trimmed}”. Saving keeps the day and drops the time.`,
    };
  }

  return {
    value: '',
    note: `Stored as “${trimmed}”, which this picker cannot read. Pick the join date to replace it, or save as it stands to clear it.`,
  };
}

/**
 * A stored join date as the operator should read it: medium date style in their
 * own locale. Anything unreadable comes back exactly as stored.
 *
 * @param locale left undefined in the app so the browser's locale wins; passed
 *   explicitly by tests that assert a specific rendering.
 */
export function formatJoinDate(raw: string, locale?: string | string[]): string {
  const day = isoDayPrefix(raw);
  if (day === null) return raw;
  const d = parseIsoDay(day);
  if (d === null) return raw;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(d);
  } catch {
    // A bad locale tag is the only way this throws, and a profile that renders
    // the raw string is a better outcome than one that does not render.
    return raw;
  }
}
