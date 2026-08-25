import type { Response } from 'express';

/**
 * Building a CSV file and handing it to the browser.
 *
 * Exports live on the server rather than in the page for one reason: a page
 * holds what it has fetched, which is one page of a list or the first fifty
 * rows of a report. An export built from that is silently short, and a short
 * export is worse than none — nothing about the file says it is missing
 * anything, so it gets reconciled against a bank statement and the difference
 * is blamed on the books.
 */

/**
 * One value, escaped.
 *
 * A field is quoted only when it has to be — a comma, a quote, or a newline
 * inside it — because quoting everything makes the file harder to read in the
 * text editor somebody will inevitably open it in. Quotes inside are doubled,
 * which is what RFC 4180 says and what Excel expects.
 */
const escape = (value: string): string =>
  /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

/** A cell, in the shapes the callers actually hold. */
export type Cell = string | number | null | undefined;

const cell = (v: Cell): string => (v == null ? '' : String(v));

/** Headers and rows, joined into a CSV document. */
export const toCsv = (
  headers: readonly string[],
  rows: readonly (readonly Cell[])[],
): string =>
  [
    headers.map(escape).join(','),
    ...rows.map(row => row.map(v => escape(cell(v))).join(',')),
  ].join('\n');

/**
 * Sends a CSV as a download.
 *
 * The BOM is deliberate. Without it Excel on Windows reads the file as the
 * system codepage and mangles every non-ASCII name in it, which in a Pakistani
 * gym is most of them. Every other reader ignores it.
 */
export const sendCsv = (res: Response, filename: string, content: string): void => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`﻿${content}`);
};

/** `name-2026-08-25.csv`, so downloads sort by date and do not overwrite. */
export const stampedName = (prefix: string, on: Date = new Date()): string =>
  `${prefix}-${on.toISOString().split('T')[0]}.csv`;
