import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import {
  INVOICE_NOT_FOUND_WORDS,
  QUOTE_NOT_FOUND_WORDS,
  invoiceLeadName,
  invoiceName,
  invoiceNumberText,
} from '../src/lib/invoiceNaming';
import {
  accountCreditAppliedWords,
  cardDeclinedAfterPaymentWords,
  cardPaymentNotPayableWords,
  draftInvoiceSentWords,
  invoicePdfDownloadedWords,
  invoicePdfMadeWords,
  invoiceSentence,
  invoiceWords,
  ledgerRowBackfilledWords,
  manualPaymentWords,
  paymentPossibleDuplicateWords,
  paymentRowRecordedWords,
  quoteRevisedWords,
  quoteSentence,
  unappliedPaymentDecidedWords,
} from '../src/lib/activityWords';
import { planApply, balanceToSettle } from '../src/lib/paymentApply';
import { pdfNumberLine, invoiceForPdf } from '../src/lib/invoicePdf';
import { checkoutLineName } from '../src/portal/payInvoice';

/**
 * #2453, #1848: THE SERVER NAMES AN INVOICE BY ITS NUMBER OR IN WORDS.
 *
 * Every case with no number hands the sentence an id of the shape the server
 * mints and checks both the words that come out and that the id did not.
 */
const ID = 'inv_1731000000000_ab12cd';

describe('invoiceNaming: the shared words', () => {
  it('reads a stored number, trimmed, and nothing else as a number', () => {
    expect(invoiceNumberText(' INV-2027-0001 ')).toBe('INV-2027-0001');
    expect(invoiceNumberText('')).toBe('');
    expect(invoiceNumberText(null)).toBe('');
    expect(invoiceNumberText(undefined)).toBe('');
    expect(invoiceNumberText(1042)).toBe('');
  });

  it('names an invoice inside a sentence', () => {
    expect(invoiceName('1042')).toBe('invoice 1042');
    expect(invoiceName('')).toBe('an invoice with no number');
    expect(invoiceName(null)).toBe('an invoice with no number');
    expect(invoiceName('  ')).toBe('an invoice with no number');
    expect(invoiceName('Q-7', 'quote')).toBe('quote Q-7');
    expect(invoiceName(undefined, 'quote')).toBe('a quote with no number');
  });

  it('names an invoice where it opens a sentence', () => {
    expect(invoiceLeadName('1042')).toBe('Invoice 1042');
    expect(invoiceLeadName('')).toBe('Invoice with no number');
    expect(invoiceLeadName('Q-7', 'quote')).toBe('Quote Q-7');
    expect(invoiceLeadName(null, 'quote')).toBe('Quote with no number');
  });

  it('says an invoice that is not there could not be found, with no id to print', () => {
    expect(INVOICE_NOT_FOUND_WORDS).toBe('Invoice not found.');
    expect(QUOTE_NOT_FOUND_WORDS).toBe('Quote not found.');
  });
});

describe('Activity Log lines about an invoice', () => {
  it('a manual payment that settles, and one that leaves a balance', () => {
    expect(manualPaymentWords('1042', true)).toBe('Invoice 1042 settled by a manually-recorded payment');
    expect(manualPaymentWords(undefined, true)).toBe('Invoice with no number settled by a manually-recorded payment');
    expect(manualPaymentWords('1042', false)).toBe(
      'Partial payment recorded against invoice 1042; a balance is still owed',
    );
    expect(manualPaymentWords('', false)).toBe(
      'Partial payment recorded against an invoice with no number; a balance is still owed',
    );
  });

  it('a payment row, and the row the sweep writes for a payoff the app never recorded', () => {
    expect(paymentRowRecordedWords('1042')).toBe('Payment row recorded against invoice 1042');
    expect(paymentRowRecordedWords('')).toBe('Payment row recorded against an invoice with no number');
    expect(ledgerRowBackfilledWords('1042')).toBe(
      'Payment ledger row recorded for invoice 1042: the app stopped after paying it off and before recording the row',
    );
    expect(ledgerRowBackfilledWords('')).toBe(
      'Payment ledger row recorded for an invoice with no number: the app stopped after paying it off and before recording the row',
    );
  });

  it('a decided held card payment: dollars, the number, and only the parts that got money', () => {
    expect(
      unappliedPaymentDecidedWords({
        paymentCents: 4000,
        creditedCents: 2500,
        appliedCents: 1000,
        keptCents: 500,
        appliedInvoiceNumber: '1042',
      }),
    ).toBe('Held card payment of $40.00 decided: $25.00 to account credit, $10.00 to invoice 1042 and $5.00 kept as recorded');
    expect(
      unappliedPaymentDecidedWords({
        paymentCents: 4000,
        creditedCents: 0,
        appliedCents: 4000,
        keptCents: 0,
        appliedInvoiceNumber: '',
      }),
    ).toBe('Held card payment of $40.00 decided: $40.00 to an invoice with no number');
    expect(
      unappliedPaymentDecidedWords({
        paymentCents: 4000,
        creditedCents: 4000,
        appliedCents: 0,
        keptCents: 0,
        appliedInvoiceNumber: '',
      }),
    ).toBe('Held card payment of $40.00 decided: $40.00 to account credit');
    expect(
      unappliedPaymentDecidedWords({
        paymentCents: 4000,
        creditedCents: 1500,
        appliedCents: 0,
        keptCents: 2500,
        appliedInvoiceNumber: '',
      }),
    ).toBe('Held card payment of $40.00 decided: $15.00 to account credit and $25.00 kept as recorded');
  });

  it('the lines that said "an invoice" or "a quote" now say it has no number', () => {
    expect(invoiceWords('')).toBe('an invoice with no number');
    expect(invoicePdfMadeWords(null)).toBe('Made the PDF for an invoice with no number');
    expect(invoicePdfDownloadedWords('')).toBe('Household downloaded the PDF for an invoice with no number');
    expect(invoiceSentence('', 'archived')).toBe('Invoice with no number archived');
    expect(invoiceSentence('1042', 'archived')).toBe('Invoice 1042 archived');
    expect(quoteSentence('', 'withdrawn')).toBe('Quote with no number withdrawn');
    expect(quoteSentence('1026', 'withdrawn')).toBe('Quote 1026 withdrawn');
    expect(draftInvoiceSentWords('1042')).toBe('Draft invoice 1042 reviewed and sent');
    expect(draftInvoiceSentWords('')).toBe('Draft invoice with no number reviewed and sent');
    expect(quoteRevisedWords('1026')).toBe('Declined quote 1026 revised and sent again');
    expect(quoteRevisedWords('')).toBe('Declined quote with no number revised and sent again');
    expect(accountCreditAppliedWords(2500, null)).toBe('Applied $25.00 account credit to an invoice with no number');
    expect(accountCreditAppliedWords(2500, '1026')).toBe('Applied $25.00 account credit to invoice 1026');
    expect(paymentPossibleDuplicateWords('')).toBe(
      'A payment was recorded for an invoice with no number that was already settled. Check for a duplicate.',
    );
    expect(paymentPossibleDuplicateWords('1042')).toBe(
      'A payment was recorded for invoice 1042, which was already settled. Check for a duplicate.',
    );
    expect(cardDeclinedAfterPaymentWords('', 'invoice-paid')).toBe(
      'A card was declined on an invoice with no number that was already paid. No notice was sent to the household.',
    );
    expect(cardPaymentNotPayableWords('', 'apply_wrong_household', 4000)).toBe(
      'A card payment of $40.00 was put on an invoice with no number, but the checkout was for a different household.',
    );
  });
});

describe('refusals from the payment apply rule', () => {
  const open = { kinfolkId: 'fam-1', status: 'open', total: 40, amountDue: 40 };
  const messageOf = (plan: { ok: boolean; refusal?: { message: string } }): string => {
    expect(plan.ok).toBe(false);
    return plan.refusal?.message ?? '';
  };

  it('an invoice that is not there', () => {
    const plan = planApply({
      invoice: { invoiceId: ID, doc: null, existingPayments: [] },
      appliedCents: 1000,
      kinfolkId: 'fam-1',
      spendableCents: 1000,
    });
    const settle = balanceToSettle({ invoiceId: ID, doc: null, existingPayments: [] }, 'fam-1');
    for (const message of [messageOf(plan), messageOf(settle)]) {
      expect(message).toBe('That invoice could not be found, so nothing can be applied to it.');
      expect(message).not.toContain(ID);
    }
  });

  it.each([
    ['', 'an invoice with no number', 'Invoice with no number'],
    ['1042', 'invoice 1042', 'Invoice 1042'],
  ])('with the number "%s"', (invoiceNumber, named, lead) => {
    const doc = { ...open, invoiceNumber };
    const zero = messageOf(
      planApply({ invoice: { invoiceId: ID, doc, existingPayments: [] }, appliedCents: 0, kinfolkId: 'fam-1', spendableCents: 1000 }),
    );
    expect(zero).toBe(
      `Nothing was entered against ${named}. Enter an amount to apply, or leave the invoice off the payment.`,
    );
    const tooMuch = messageOf(
      planApply({ invoice: { invoiceId: ID, doc, existingPayments: [] }, appliedCents: 2000, kinfolkId: 'fam-1', spendableCents: 1500 }),
    );
    expect(tooMuch).toBe(
      `$20.00 was applied to ${named}, but this payment has only $15.00 to give once its tip is set aside. ` +
        'Lower the applied amount, lower the tip, or raise the payment amount.',
    );
    const otherHousehold = messageOf(
      planApply({ invoice: { invoiceId: ID, doc, existingPayments: [] }, appliedCents: 1000, kinfolkId: 'fam-2', spendableCents: 1000 }),
    );
    expect(otherHousehold).toBe(`${lead} belongs to a different household than this payment.`);
    const draft = messageOf(
      planApply({
        invoice: { invoiceId: ID, doc: { ...doc, status: 'draft' }, existingPayments: [] },
        appliedCents: 1000,
        kinfolkId: 'fam-1',
        spendableCents: 1000,
      }),
    );
    expect(draft).toBe(`${lead} is a draft or quote; send it before applying a payment to it.`);
    const settleOther = messageOf(balanceToSettle({ invoiceId: ID, doc, existingPayments: [] }, 'fam-2'));
    expect(settleOther).toBe(`${lead} belongs to a different household than this payment.`);
    const settleDraft = messageOf(
      balanceToSettle({ invoiceId: ID, doc: { ...doc, status: 'draft' }, existingPayments: [] }, 'fam-1'),
    );
    expect(settleDraft).toBe(`${lead} is a draft or quote; send it before applying a payment to it.`);
    for (const message of [zero, tooMuch, otherHousehold, draft, settleOther, settleDraft]) {
      expect(message).not.toContain(ID);
    }
  });
});

describe('what the household reads: the PDF and the card checkout line', () => {
  it('the PDF prints the number, or says there is none, and never the id', () => {
    expect(pdfNumberLine('open', '1042')).toBe('Invoice #: 1042');
    expect(pdfNumberLine('quote', 'Q-7')).toBe('Quote #: Q-7');
    expect(pdfNumberLine('open', '')).toBe('Invoice with no number');
    expect(pdfNumberLine('quote', '')).toBe('Quote with no number');
    expect(invoiceForPdf(ID, { total: 40, status: 'open' }).invoiceNumber).toBe('');
    expect(invoiceForPdf(ID, { total: 40, status: 'open', invoiceNumber: ' 1042 ' }).invoiceNumber).toBe('1042');
  });

  it("Stripe's checkout page names the invoice by its number", () => {
    expect(checkoutLineName('1042')).toBe('Invoice #1042');
    expect(checkoutLineName('')).toBe('Invoice with no number');
    expect(checkoutLineName(undefined)).toBe('Invoice with no number');
  });
});

/**
 * THE GUARD. No sentence under `src/` may interpolate an invoice id into a
 * refusal or an Activity Log description again. It reads the source, so a new
 * callable that writes "Invoice '${args.invoiceId}' not found." fails here.
 */
describe('no source sentence carries an invoice id', () => {
  const SRC = join(__dirname, '..', 'src');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(full);
    }
  };
  walk(SRC);

  it('reads the source tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('the guard catches the sentences this change removed', () => {
    // If the patterns below stop matching these, the guard is blind.
    const ID = String.raw`\$\{[^}]*(\b\w*[Ii]nvoice\w*Id\b|\b\w*[Ii]nv\w*\.id\b)[^}]*\}`;
    const NAMED_BY_ID = new RegExp(`\`[^\`]*\\b([Ii]nvoice|[Qq]uote) #?'?${ID}`);
    for (const was of [
      "throw new HttpsError('not-found', `Invoice '${args.invoiceId}' not found.`);",
      "throw new HttpsError('not-found', `Quote '${args.invoiceId}' not found.`);",
      '`Invoice ${plannedApply.step.invoiceNumber || applyInvoiceId} owes ${usd(1)}, `',
      '? `Invoice ${data.invoiceNumber ?? args.invoiceId} settled by a manually-recorded payment`',
      'name: `Invoice #${args.invoiceId}`,',
    ]) {
      expect(NAMED_BY_ID.test(was), was).toBe(true);
    }
  });

  it('in a thrown refusal, a refusal message or an Activity Log description', () => {
    // Any `${...}` that reads an invoice's id: invoiceId, applyInvoiceId, invoice.id, invoiceRef.id and the like.
    const ID = String.raw`\$\{[^}]*(\b\w*[Ii]nvoice\w*Id\b|\b\w*[Ii]nv\w*\.id\b)[^}]*\}`;
    const SENTENCE_KEY = String.raw`(HttpsError\(\s*'[a-z-]+',|message:|description:|refuse\()`;
    const ID_IN_SENTENCE = new RegExp(`${SENTENCE_KEY}\\s*\`[^\`]*${ID}`);
    const KEY_ENDS_LINE = new RegExp(`${SENTENCE_KEY}\\s*$`);
    const ID_IN_TEMPLATE = new RegExp(`\`[^\`]*${ID}`);
    const NAMED_BY_ID = new RegExp(`\`[^\`]*\\b([Ii]nvoice|[Qq]uote) #?'?${ID}`);
    const hits: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
        const keyAbove = i > 0 && KEY_ENDS_LINE.test(lines[i - 1] ?? '') && ID_IN_TEMPLATE.test(line);
        if (ID_IN_SENTENCE.test(line) || NAMED_BY_ID.test(line) || keyAbove) hits.push(`${relative(SRC, file)}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
