/** @format */

/**
 * Turning the days a caller names into the instants a query needs.
 *
 * A `?to=2026-08-31` means "up to the end of the 31st", not "up to the moment
 * the 31st began" — without stretching it, a payment taken at 2pm on the
 * closing day falls outside a range that ends on its own date.
 */

/**
 * The last instant of the day a date-only filter names.
 *
 * `setUTCHours`, not `setHours`, and the distinction is the whole reason this
 * lives in one place. Zod's `z.coerce.date()` parses `2026-08-31` as UTC
 * midnight; moving that to *local* end-of-day lands short of the real one by
 * the server's offset. In Pakistan (UTC+5) the range quietly ended at 18:59
 * UTC, so everything recorded after 7pm on the closing day vanished from
 * reports — the kind of gap that reads as "we took less this month" rather
 * than as a bug.
 *
 * Only for dates that arrived as a date-only string. A timestamp built from
 * `new Date()` is already local and must not be passed through here.
 */
export const endOfDayUtc = (d: Date): Date => {
  const end = new Date(d);
  end.setUTCHours(23, 59, 59, 999);
  return end;
};
