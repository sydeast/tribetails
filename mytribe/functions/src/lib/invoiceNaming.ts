/**
 * HOW THE SERVER NAMES AN INVOICE IN A SENTENCE (#2453, #1848).
 *
 * Refusals, Activity Log lines, the PDF and the card checkout line used to put
 * the invoice's stored id where its number belongs, either always ("Invoice
 * '<id>' not found.") or whenever the invoice had no number. A person reads
 * every one of those, and an installed app prints a refusal as the server
 * wrote it, so the words are fixed here and nowhere else.
 *
 * The id still travels beside the sentence, as the callable's `details`, the
 * Activity Log entry's target and payload, and the log line. It is never part
 * of the sentence.
 *
 * The wording for an invoice with no number is the admin apps' (#2417, #2420):
 * "an invoice with no number" inside a sentence, "Invoice with no number"
 * where it opens one. Both functions return the WHOLE noun phrase, so a caller
 * never writes "invoice" in front of it.
 */

export type InvoiceKind = 'invoice' | 'quote';

/** The stored number as it prints, or `''` when the invoice carries none. */
export function invoiceNumberText(invoiceNumber: unknown): string {
  return typeof invoiceNumber === 'string' ? invoiceNumber.trim() : '';
}

/** Inside a sentence: "invoice 1042", or "an invoice with no number". */
export function invoiceName(invoiceNumber: unknown, kind: InvoiceKind = 'invoice'): string {
  const n = invoiceNumberText(invoiceNumber);
  if (n !== '') return `${kind} ${n}`;
  return kind === 'quote' ? 'a quote with no number' : 'an invoice with no number';
}

/** Opening a sentence or standing alone: "Invoice 1042", or "Invoice with no number". */
export function invoiceLeadName(invoiceNumber: unknown, kind: InvoiceKind = 'invoice'): string {
  const n = invoiceNumberText(invoiceNumber);
  const noun = kind === 'quote' ? 'Quote' : 'Invoice';
  return n === '' ? `${noun} with no number` : `${noun} ${n}`;
}

/**
 * The refusal for an invoice id that names no stored invoice. There is no
 * document, so there is no number to give and "with no number" would be a
 * guess; the sentence says only that it was not found.
 */
export const INVOICE_NOT_FOUND_WORDS = 'Invoice not found.';
/** The same refusal where the caller asked for a quote. */
export const QUOTE_NOT_FOUND_WORDS = 'Quote not found.';
