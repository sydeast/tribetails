import { randomUUID } from 'crypto';
import {
  METHOD_SPECS,
  isMethodEnabled,
  payMethodSettingsFrom,
  settingsForInvoice,
  type OperatorSettings,
} from './paymentMethods';
import { getAdmin } from './firestoreAdmin';
import { lineAmountCents } from './invoiceMath';

/**
 * Stage 3 / 16.2 - server-side invoice PDF.
 *
 * Renders an invoice doc to a real PDF with pdf-lib (pure JS, no Chromium) and
 * stores it in the project's default Cloud Storage bucket, returning a
 * download-token URL (the same shape the Firebase client SDK's getDownloadURL
 * produces). The download token avoids the getSignedUrl IAM signing step, so
 * no extra service-account role / operator grant is required; the token is an
 * unguessable per-file secret, so the invoice is not publicly enumerable.
 *
 * The PDF is rendered ONLY from fields already on the invoice doc. Nothing here
 * is fabricated.
 *
 * WHAT TASK 5.1 CHANGED, since the comment that stood here was load-bearing and
 * is now false: the flat `invoices` doc DOES carry an itemized `lineItems` array
 * once an operator has itemized it, written by `createInvoice` and
 * `updateInvoice`. When it is present the items table below is the real billed
 * detail and is rendered as such. When it is ABSENT, which is every invoice
 * created before 5.1, the authoritative scalar summary is still the only thing
 * there is to show, and is still rendered on its own exactly as before.
 *
 * AN EMPTY ITEMS TABLE IS NEVER DRAWN. A heading over no rows reads as "nothing
 * was billed", which on a document a household receives is a worse claim than
 * saying nothing at all.
 *
 * THE PER-LINE AMOUNTS ARE DERIVED HERE, from `qty` and `unitCents` through the
 * shared `lib/invoiceMath.ts`, not read off the doc. There is no stored per-line
 * amount to read, and deriving it in the renderer is what makes the printed
 * lines and the printed total obey one rule.
 */

export interface InvoiceLineForPdf {
  description: string;
  qty: number;
  unitCents: number;
  discountCents: number;
  /** DERIVED: Math.round(qty x unitCents) - discountCents, via invoiceMath. */
  amountCents: number;
}

export interface InvoiceForPdf {
  id: string;
  invoiceNumber: string;
  kinfolkName: string;
  client: string;
  address: string;
  date: string;
  dueDate: string;
  terms: string;
  discount: string;
  status: string;
  total: number;
  amountDue: number;
  paymentsHistory: string;
  /** Empty when this invoice was never itemized. Never a fabricated single row. */
  lineItems: InvoiceLineForPdf[];
  /** Whole-invoice reduction in cents. 0, and unprinted, when absent. */
  invoiceDiscountCents: number;
  /** Sum of the line amounts BEFORE the invoice-level discount, in cents. */
  subtotalCents: number;
  // Payments: operator-entered handles (Venmo/PayPal/Cash App), pre-formatted for the
  // "How to pay" footer. Sourced from business_settings, not the invoice doc.
  paymentMethods: string;
}

/**
 * The stored line items, defensively.
 *
 * This reads a RAW Firestore document, not a validated payload. The callables
 * validate what they write, but `firestore.rules` grants `allow update: if
 * isAuntie()` over the whole collection and `postInvoiceEvent` merges an
 * arbitrary payload, so a malformed row can genuinely be sitting on a doc. A bad
 * row is DROPPED rather than thrown on: throwing here would fail the entire PDF
 * and leave the operator with no document at all, which is a worse outcome than
 * one missing line on a document they are about to read before sending.
 */
export function lineItemsForPdf(raw: unknown): InvoiceLineForPdf[] {
  if (!Array.isArray(raw)) return [];
  const out: InvoiceLineForPdf[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const li = entry as Record<string, unknown>;
    const rawQty = li['qty'];
    const rawUnit = li['unitCents'];
    const rawDiscount = li['discountCents'];
    const description = typeof li['description'] === 'string' ? li['description'] : '';
    const qty = typeof rawQty === 'number' && Number.isFinite(rawQty) ? rawQty : NaN;
    const unitCents = typeof rawUnit === 'number' && Number.isFinite(rawUnit) ? rawUnit : NaN;
    if (description.trim() === '' || !Number.isFinite(qty) || !Number.isFinite(unitCents)) continue;
    const discountCents =
      typeof rawDiscount === 'number' && Number.isFinite(rawDiscount) ? rawDiscount : 0;
    out.push({
      description,
      qty,
      unitCents,
      discountCents,
      amountCents: lineAmountCents({ description, qty, unitCents, discountCents }),
    });
  }
  return out;
}

/** Reads the PDF-relevant fields off a raw invoice doc, defaulting missing scalars. */
export function invoiceForPdf(id: string, data: Record<string, unknown>): InvoiceForPdf {
  const str = (k: string): string => (typeof data[k] === 'string' ? (data[k] as string) : '');
  const num = (k: string): number => {
    const v = data[k];
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const p = parseFloat(v);
      return Number.isFinite(p) ? p : 0;
    }
    return 0;
  };
  const intOr0 = (k: string): number => {
    const v = data[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  const lineItems = lineItemsForPdf(data['lineItems']);
  return {
    id,
    invoiceNumber: str('invoiceNumber') || id,
    kinfolkName: str('kinfolkName'),
    client: str('client'),
    address: str('address'),
    date: str('date'),
    dueDate: str('dueDate'),
    terms: str('terms'),
    discount: str('discount'),
    status: str('status') || str('invoiceStatus'),
    total: num('total'),
    amountDue: num('amountDue'),
    paymentsHistory: str('paymentsHistory'),
    lineItems,
    invoiceDiscountCents: intOr0('invoiceDiscountCents'),
    // Summed from the lines rather than read from the stored `subtotalCents`.
    // The stored figure and the lines can genuinely disagree (see the note in
    // `admin/updateInvoice.ts`), and on a document the household receives the
    // printed lines must add up to the printed subtotal.
    subtotalCents: lineItems.reduce((sum, li) => sum + li.amountCents, 0),
    paymentMethods: '', // set from business_settings in generateAndStoreInvoicePdf
  };
}

function usd(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${abs.toFixed(2)}`;
}

/** "$36.00" from an INTEGER count of cents. The line-item money is cents, not dollars. */
export function usdCents(cents: number): string {
  const n = Number.isFinite(cents) ? cents : 0;
  const sign = n < 0 ? '-' : '';
  return `${sign}$${(Math.abs(n) / 100).toFixed(2)}`;
}

/**
 * "2" for a whole quantity, "2.5" for a fractional one.
 *
 * `qty` may legitimately be fractional (2.5 hours), so it cannot be printed as
 * an integer; but printing "2.00 visits" for two visits reads like a money
 * figure on a document that is full of money figures. Trailing zeroes are
 * dropped rather than padded.
 */
export function formatQty(qty: number): string {
  if (!Number.isFinite(qty)) return '0';
  return Number.isInteger(qty) ? String(qty) : String(Number(qty.toFixed(2)));
}

// pdf-lib's StandardFonts (Helvetica) can only encode WinAnsi (cp1252). Drawing
// a code point outside it (CJK, Cyrillic, Greek, emoji, ...) THROWS, which would
// hard-fail the whole render for an international kinfolk name/address. Map every
// non-cp1252 code point to '?' so the PDF always renders. cp1252 = Latin-1
// (<=0xFF) plus this high-range set of typographic/symbol chars.
const CP1252_HIGH = new Set<number>([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
  0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

/** Replaces any character the WinAnsi standard font cannot encode with '?'. Pure. */
export function winAnsiSafe(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0x3f;
    out += cp <= 0xff || CP1252_HIGH.has(cp) ? ch : '?';
  }
  return out;
}

/**
 * Renders the invoice to PDF bytes. Pure (no IO): deterministic given the input,
 * so it is unit-testable on its own. Single Letter-size page, Helvetica.
 */
export async function renderInvoicePdf(inv: InvoiceForPdf): Promise<Uint8Array> {
  // pdf-lib is loaded here, not at file scope. Two functions render invoice
  // PDFs; the Functions runtime loads all of `index.js` on every cold start
  // whatever the target is, so at file scope the other 225 were carrying a PDF
  // engine they never touch.
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // US Letter
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const navy = rgb(0.13, 0.18, 0.29);
  const dim = rgb(0.45, 0.45, 0.5);
  const left = 56;
  let y = 740;

  const line = (text: string, opts: { size?: number; f?: typeof font; color?: typeof navy; x?: number } = {}) => {
    // winAnsiSafe so a non-Latin field never throws mid-render.
    page.drawText(winAnsiSafe(text), { x: opts.x ?? left, y, size: opts.size ?? 11, font: opts.f ?? font, color: opts.color ?? navy });
  };
  const gap = (n = 18) => { y -= n; };

  line('Tribe Tails', { size: 22, f: bold });
  gap(16);
  line('INVOICE', { size: 14, f: bold, color: dim });
  gap(28);

  line(`Invoice #: ${inv.invoiceNumber}`, { f: bold });
  gap();
  if (inv.status) { line(`Status: ${inv.status}`); gap(); }
  if (inv.date) { line(`Date: ${inv.date}`); gap(); }
  if (inv.dueDate) { line(`Due: ${inv.dueDate}`); gap(); }
  gap(10);

  line('Bill to', { f: bold, color: dim });
  gap();
  if (inv.client) { line(inv.client); gap(); }
  else if (inv.kinfolkName) { line(inv.kinfolkName); gap(); }
  if (inv.address) { line(inv.address); gap(); }
  gap(10);

  // THE ITEMS TABLE, drawn only when this invoice was actually itemized. An
  // un-itemized invoice falls straight through to the scalar summary below,
  // which is exactly what it did before line items existed.
  if (inv.lineItems.length > 0) {
    const qtyX = 300;
    const unitX = 370;
    const amountX = 470;

    line('Items', { f: bold, color: dim });
    gap();
    line('Description', { size: 9, color: dim });
    line('Qty', { size: 9, color: dim, x: qtyX });
    line('Unit', { size: 9, color: dim, x: unitX });
    line('Amount', { size: 9, color: dim, x: amountX });
    gap(14);

    for (const li of inv.lineItems) {
      // The description is the only unbounded field on the row, so it is the
      // only one truncated. Truncating a number would misstate money.
      const desc = li.description.length > 46 ? `${li.description.slice(0, 45)}…` : li.description;
      line(desc, { size: 10 });
      line(formatQty(li.qty), { size: 10, x: qtyX });
      line(usdCents(li.unitCents), { size: 10, x: unitX });
      line(usdCents(li.amountCents), { size: 10, x: amountX });
      gap(14);
      // A per-line discount is printed on its own sub-line rather than folded
      // silently into the amount, so the household can see what was taken off.
      if (li.discountCents > 0) {
        line(`includes ${usdCents(li.discountCents)} off`, { size: 9, color: dim, x: 64 });
        gap(13);
      }
    }
    gap(4);
    line('Subtotal', { size: 10, color: dim, x: unitX });
    line(usdCents(inv.subtotalCents), { size: 10, x: amountX });
    gap(14);
    if (inv.invoiceDiscountCents > 0) {
      line('Discount', { size: 10, color: dim, x: unitX });
      line(`-${usdCents(inv.invoiceDiscountCents)}`, { size: 10, x: amountX });
      gap(14);
    }
    gap(6);
  }

  line('Amounts', { f: bold, color: dim });
  gap();
  line(`Total: ${usd(inv.total)}`);
  gap();
  // The free-text `discount` string is the LEGACY field, and on an itemized
  // invoice the real reduction is already printed above in cents. Printing both
  // would show the same invoice two discounts.
  if (inv.lineItems.length === 0 && inv.discount && inv.discount !== '0' && inv.discount !== '0.00') {
    line(`Discount: ${inv.discount}`); gap();
  }
  line(`Amount due: ${usd(inv.amountDue)}`, { f: bold });
  gap(16);

  if (inv.terms) { line('Terms', { f: bold, color: dim }); gap(); line(inv.terms); gap(16); }

  if (inv.paymentsHistory) {
    line('Payments', { f: bold, color: dim });
    gap();
    // paymentsHistory is a stored free-text/JSON string; render it line-wrapped.
    for (const seg of wrap(inv.paymentsHistory, 80)) { line(seg, { size: 10, color: dim }); gap(13); }
    gap(16);
  }

  // Payments: operator-entered handles so the kinfolk can pay directly.
  if (inv.paymentMethods) {
    line('How to pay', { f: bold, color: dim });
    gap();
    for (const seg of wrap(inv.paymentMethods, 80)) { line(seg, { size: 10 }); gap(13); }
  }

  page.drawText('Generated by Tribe Tails', { x: left, y: 48, size: 9, font, color: dim });

  return doc.save();
}

/** Naive word-wrap so long payment strings don't overflow the page width. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let cur = '';
    for (const word of raw.split(/\s+/)) {
      if ((cur + ' ' + word).trim().length > width) { if (cur) out.push(cur); cur = word; }
      else cur = (cur + ' ' + word).trim();
    }
    out.push(cur);
  }
  return out.slice(0, 30); // hard cap so a pathological string can't blow up the page
}

/**
 * Stores the PDF bytes in the default bucket at the STABLE path
 * invoice_pdfs/{invoiceId}.pdf and returns a Firebase download-token URL.
 *
 * Writing to a stable path (not a per-render filename) bounds storage to one
 * object per invoice, and minting a FRESH single token each render OVERWRITES the
 * previous token in metadata - so an earlier download URL is automatically
 * revoked (a leaked old URL stops working after the next render) and orphaned
 * tokenized copies never accumulate. The token is a 122-bit UUID, so the live
 * URL is unguessable; the URL is never logged or stored in the audit payload.
 */
export async function storeInvoicePdf(invoiceId: string, bytes: Uint8Array): Promise<string> {
  const bucket = getAdmin().storage().bucket();
  const token = randomUUID();
  const path = `invoice_pdfs/${encodeURIComponent(invoiceId)}.pdf`;
  await bucket.file(path).save(Buffer.from(bytes), {
    contentType: 'application/pdf',
    metadata: { metadata: { firebaseStorageDownloadTokens: token } },
  });
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

/** Convenience: render + store in one step. Returns the download URL. */
/**
 * Operator-entered payment options -> one printable "How to pay" line.
 *
 * ISSUE #409: the three handles are still read from exactly the fields they
 * always lived in, and a settings doc with no `paymentOptions` map prints
 * character for character what it printed before. What changed is that a
 * method the operator has switched OFF stops printing, and the methods that
 * are a sentence rather than a handle (Zelle, cash, check, bank transfer)
 * print their instructions.
 *
 * Driven off `METHOD_SPECS` rather than three hardcoded reads, so the paper
 * bill and the portal screen can never offer different things: adding a
 * method to the registry adds it here.
 */
export function formatPaymentMethods(settings: OperatorSettings): string {
  const parts: string[] = [];
  for (const spec of METHOD_SPECS) {
    if (!isMethodEnabled(settings, spec)) continue;
    if (spec.kind === 'checkout') continue; // The card is paid through the portal, not off the page.
    if (spec.kind === 'instructions') {
      const written = settings.paymentOptions?.[spec.id]?.instructions?.trim();
      if (written) parts.push(`${spec.shortLabel}: ${written}`);
      continue;
    }
    const handle = spec.field ? (settings[spec.field] ?? '').trim() : '';
    if (handle) parts.push(`${spec.shortLabel}: ${handle}`);
  }
  return parts.join('    •    ');
}

export async function generateAndStoreInvoicePdf(id: string, data: Record<string, unknown>): Promise<string> {
  const inv = invoiceForPdf(id, data);
  // Payments: pull the operator's options off business_settings and print
  // them. Fail-soft: a settings read error just omits the section (never
  // blocks the PDF).
  //
  // Issue #409: an invoice that carries its own frozen options is printed
  // from those, so a PDF regenerated next month says what the household was
  // originally told rather than what the settings happen to say today. An
  // invoice with no snapshot prints from live settings, exactly as before.
  try {
    const snap = await getAdmin().firestore().collection('business_settings').doc('business_settings').get();
    inv.paymentMethods = formatPaymentMethods(
      settingsForInvoice(data, payMethodSettingsFrom(snap.data() ?? {})),
    );
  } catch {
    inv.paymentMethods = '';
  }
  const bytes = await renderInvoicePdf(inv);
  return storeInvoicePdf(id, bytes);
}
