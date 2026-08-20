/** @format */

/**
 * Turning the phone numbers a gym types into the ones WhatsApp will accept.
 *
 * The front desk writes `0300-1234567`, or `0300 1234567`, or `+92 300
 * 1234567` — whatever the member read out. WhatsApp wants `923001234567`:
 * country code, no plus, no leading zero, no separators. Nothing in the app
 * has needed that until now, so numbers are stored exactly as typed and the
 * conversion happens here.
 *
 * Getting this wrong is quiet in both directions. A number that fails to
 * convert sends nothing, and a number that converts *wrongly* sends a member's
 * renewal notice to a stranger — so this refuses anything it cannot place
 * rather than guessing. A refusal is visible in the run counts; a wrong
 * recipient is not.
 */

/** Pakistan. The only country this is currently sold in. */
const COUNTRY_CODE = '92';

/**
 * A Pakistani mobile number, as the network actually assigns them.
 *
 * Mobile prefixes are `03xx` locally — `030` through `034` for the operators
 * plus `035` and `036` for newer allocations. Ten digits after the country
 * code, always.
 */
const PK_MOBILE = /^3[0-6]\d{8}$/;

/**
 * A number belonging to some other country, kept if it is plausibly one.
 *
 * Long enough to be real rather than a typo, and short enough to be a number
 * at all — E.164 caps at 15 digits. No attempt is made to verify the mobile
 * ranges of every country: Meta knows them and rejects what is malformed,
 * whereas refusing here would make foreign members permanently unreachable.
 */
const foreign = (digits: string): string | null =>
  digits.length >= 8 && digits.length <= 15 ? digits : null;

/**
 * The number as WhatsApp addresses it, or null when it is not a mobile this
 * can place.
 *
 * Null covers three different problems that all end the same way — nothing is
 * sent:
 *
 * - **A landline.** `042-35881234` is a real number that cannot receive
 *   WhatsApp. Gyms do record them, usually as an emergency contact.
 * - **A foreign number.** An expatriate member's `+971` number is valid and
 *   reachable, but this cannot verify the shape of every country's mobile
 *   ranges, and a malformed one bounces at Meta rather than here. Passed
 *   through only when it already carries a country code.
 * - **Nonsense.** Half a number, a note, an empty field.
 */
export const toWhatsAppNumber = (raw: string | null | undefined): string | null => {
  if (!raw) return null;

  // Everything that is not a digit goes: spaces, dashes, brackets, and the
  // leading plus, which WhatsApp does not want anyway.
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  // Already carries the country code, with or without the plus that was just
  // stripped: `923001234567`.
  if (digits.startsWith(COUNTRY_CODE)) {
    const national = digits.slice(COUNTRY_CODE.length);
    return PK_MOBILE.test(national) ? digits : null;
  }

  // `00` is the trunk prefix for dialling *out*, so `0092…` and `0044…` mean
  // the same as `+92…` and `+44…`. Checked before the single zero below, which
  // would otherwise swallow these and read the second zero as part of the
  // national number.
  if (digits.startsWith('00')) {
    const international = digits.slice(2);
    return international.startsWith(COUNTRY_CODE) || PK_MOBILE.test(international)
      ? toWhatsAppNumber(international)
      : foreign(international);
  }

  // Local form: `03001234567`. The zero is a trunk prefix for dialling inside
  // the country and is not part of the number internationally.
  if (digits.startsWith('0')) {
    const national = digits.slice(1);
    return PK_MOBILE.test(national) ? COUNTRY_CODE + national : null;
  }

  // Written without either prefix: `3001234567`.
  if (PK_MOBILE.test(digits)) return COUNTRY_CODE + digits;

  // A foreign number, already in international form — an expatriate member's
  // `+971…`, which arrives here as bare digits once the plus was stripped.
  return foreign(digits);
};

/** Whether a number can be messaged at all, without building the address. */
export const canWhatsApp = (raw: string | null | undefined): boolean =>
  toWhatsAppNumber(raw) !== null;
