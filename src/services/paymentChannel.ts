/** @format */

import type { PaymentChannel } from "../schemas.js";

/**
 * How each channel is written where a person will read it — a receipt, an
 * export, an audit row.
 *
 * The stored values are lowercase keys, which is right for a column and wrong
 * for a page: "jazzcash" is not how JazzCash is spelled. Kept in one place so
 * the CSV a gym reconciles against and the form the front desk uses cannot
 * drift into calling the same channel two different things.
 */
export const CHANNEL_LABELS: Record<PaymentChannel, string> = {
  easypaisa: "Easypaisa",
  jazzcash: "JazzCash",
  bank: "Bank Transfer",
};

/**
 * The label for a channel read back from the database, where the column is a
 * plain string and may hold something this build does not know about — a value
 * written by a newer version, or one since retired. Unknown values are shown as
 * stored rather than blanked: a row that says "sadapay" is more use to whoever
 * is reconciling than an empty cell.
 */
export const channelLabel = (channel: string | null): string => {
  if (!channel) return "";
  return (
    (CHANNEL_LABELS as Record<string, string | undefined>)[channel] ?? channel
  );
};

/** The gym-settings column holding each channel's published account details. */
export const CHANNEL_ACCOUNT_FIELD = {
  easypaisa: "easypaisaAccount",
  jazzcash: "jazzcashAccount",
  bank: "bankAccount",
} as const satisfies Record<PaymentChannel, string>;
