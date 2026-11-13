// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Async } from '../lib/async';
import type { SessionEntry } from '../api/sessions';
import type { LinkInvoiceSessionsResult } from '../contracts/invoiceContracts.generated';

const { linkInvoiceSessions } = vi.hoisted(() => ({ linkInvoiceSessions: vi.fn() }));
vi.mock('../api/invoicesWrite', async (orig) => ({
  ...(await orig<typeof import('../api/invoicesWrite')>()),
  linkInvoiceSessions,
}));

const useCollection = vi.fn();
vi.mock('../lib/firestore', async (orig) => ({
  ...(await orig<typeof import('../lib/firestore')>()),
  useCollection: (spec: unknown) => useCollection(spec),
}));

// #1744: services are named from the KinCare catalog. "Long walk" runs 45
// minutes, so a stored `visit_45` reads as "Long walk".
vi.mock('../lib/useBookingCatalog', () => ({
  useBookingCatalog: () => ({ serviceRates: { 'Long walk': '45' }, serviceDurations: { 'Long walk': '45' }, timeBlocks: [] }),
}));

import {
  InvoiceLinkVisitsEditor,
  LINK_ADDS_NO_PRICE_TEXT,
  LINK_ADDS_NO_PRICE_TITLE,
  linkVisitsSavedText,
  onOtherInvoice,
} from './InvoiceLinkVisitsEditor';

function ready<T>(data: T[]): Async<T[]> {
  return { status: 'ready', data };
}

function visit(id: string, over: Partial<SessionEntry> = {}): SessionEntry {
  return {
    _id: id,
    kinfolkId: 'kf1',
    serviceType: `Walk ${id}`,
    startTime: '2026-07-10T15:00:00Z',
    status: 'COMPLETED',
    ...over,
  } as SessionEntry;
}

function result(over: Partial<LinkInvoiceSessionsResult> = {}): LinkInvoiceSessionsResult {
  return {
    ok: true,
    invoiceId: 'inv1',
    sessionIds: [],
    added: [],
    removed: [],
    linkedWithoutLine: [],
    status: 'open',
    editScope: 'all',
    ...over,
  };
}

function box(id: string): HTMLInputElement {
  return screen.getByRole('checkbox', { name: new RegExp(`Walk ${id}\\b`) });
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /^(Save|Saving…)$/ });
}

beforeEach(() => {
  linkInvoiceSessions.mockReset();
  useCollection.mockReset();
});

describe('InvoiceLinkVisitsEditor', () => {
  it('#1744: names each visit by its KinCare, never the stored key', () => {
    useCollection.mockReturnValue(ready([visit('s1', { serviceType: 'visit_45' })]));
    render(
      <InvoiceLinkVisitsEditor invoiceId="inv1" kinfolkId="kf1" linkedIds={[]} onCancel={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.getByRole('checkbox', { name: /^Link Long walk on / })).toBeInTheDocument();
    expect(screen.getByText('Long walk')).toBeInTheDocument();
    expect(screen.queryByText(/visit_45/)).toBeNull();
  });
  it("lists the household's visits from the household query, linked ones ticked", () => {
    useCollection.mockReturnValue(ready([visit('s1', { invoiceId: 'inv1' }), visit('s2')]));
    render(
      <InvoiceLinkVisitsEditor
        invoiceId="inv1"
        kinfolkId="kf1"
        linkedIds={['s1']}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(useCollection).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'kin_care_sessions',
        filters: [['kinfolkId', '==', 'kf1']],
      }),
    );
    expect(box('s1').checked).toBe(true);
    expect(box('s2').checked).toBe(false);
    expect(box('s2').disabled).toBe(false);
  });

  it('shows a visit on another invoice but will not let it be ticked', () => {
    useCollection.mockReturnValue(ready([visit('s3', { invoiceId: 'invOther' })]));
    render(
      <InvoiceLinkVisitsEditor invoiceId="inv1" kinfolkId="kf1" linkedIds={[]} onCancel={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(box('s3').disabled).toBe(true);
    expect(screen.getByText(/on another invoice/)).toBeInTheDocument();
  });

  it('lets a visit this invoice already claims be unticked even if its back-link points elsewhere', () => {
    useCollection.mockReturnValue(ready([visit('s4', { invoiceId: 'invOther' })]));
    render(
      <InvoiceLinkVisitsEditor invoiceId="inv1" kinfolkId="kf1" linkedIds={['s4']} onCancel={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(box('s4').checked).toBe(true);
    expect(box('s4').disabled).toBe(false);
  });

  it('offers Save only once something changed', async () => {
    const user = userEvent.setup();
    useCollection.mockReturnValue(ready([visit('s1'), visit('s2')]));
    render(
      <InvoiceLinkVisitsEditor invoiceId="inv1" kinfolkId="kf1" linkedIds={['s1']} onCancel={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(saveButton().disabled).toBe(true);
    await user.click(box('s2'));
    expect(saveButton().disabled).toBe(false);
    await user.click(box('s2'));
    expect(saveButton().disabled).toBe(true);
  });

  it('sends the FULL new set, including a linked id the household list never loaded', async () => {
    const user = userEvent.setup();
    useCollection.mockReturnValue(ready([visit('s1'), visit('s2')]));
    linkInvoiceSessions.mockResolvedValue(result({ added: ['s2'] }));
    const onSaved = vi.fn();
    render(
      <InvoiceLinkVisitsEditor
        invoiceId="inv1"
        kinfolkId="kf1"
        linkedIds={['s1', 'legacy9']}
        onCancel={vi.fn()}
        onSaved={onSaved}
      />,
    );
    // The unloaded link has its own row, still ticked.
    expect((screen.getByRole('checkbox', { name: 'Link visit legacy9' }) as HTMLInputElement).checked).toBe(true);
    await user.click(box('s2'));
    await user.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(linkInvoiceSessions).toHaveBeenCalledTimes(1);
    const [invoiceId, ids] = linkInvoiceSessions.mock.calls[0] as [string, string[]];
    expect(invoiceId).toBe('inv1');
    expect([...ids].sort()).toEqual(['legacy9', 's1', 's2']);
    expect(onSaved).toHaveBeenCalledWith(result({ added: ['s2'] }));
  });

  it('sends an empty set when every link is unticked', async () => {
    const user = userEvent.setup();
    useCollection.mockReturnValue(ready([visit('s1')]));
    linkInvoiceSessions.mockResolvedValue(result({ removed: ['s1'] }));
    render(
      <InvoiceLinkVisitsEditor invoiceId="inv1" kinfolkId="kf1" linkedIds={['s1']} onCancel={vi.fn()} onSaved={vi.fn()} />,
    );
    await user.click(box('s1'));
    await user.click(saveButton());
    await waitFor(() => expect(linkInvoiceSessions).toHaveBeenCalledWith('inv1', []));
  });

  it('shows a loading cue and locks every control while the save is in flight', async () => {
    const user = userEvent.setup();
    useCollection.mockReturnValue(ready([visit('s1'), visit('s2')]));
    let resolve!: (r: LinkInvoiceSessionsResult) => void;
    linkInvoiceSessions.mockReturnValue(new Promise<LinkInvoiceSessionsResult>((r) => { resolve = r; }));
    const onBusyChange = vi.fn();
    const onSaved = vi.fn();
    render(
      <InvoiceLinkVisitsEditor
        invoiceId="inv1"
        kinfolkId="kf1"
        linkedIds={[]}
        onCancel={vi.fn()}
        onSaved={onSaved}
        onBusyChange={onBusyChange}
      />,
    );
    await user.click(box('s1'));
    await user.click(saveButton());

    expect(saveButton()).toHaveTextContent('Saving…');
    expect(saveButton()).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('region', { name: 'Link visits' })).toHaveAttribute('aria-busy', 'true');
    expect(box('s1').disabled).toBe(true);
    expect(box('s2').disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    // A second press while in flight does not send a second call.
    await user.click(saveButton());
    expect(linkInvoiceSessions).toHaveBeenCalledTimes(1);

    resolve(result({ added: ['s1'] }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("shows the server's refusal verbatim, stays open, and keeps every pick", async () => {
    const user = userEvent.setup();
    useCollection.mockReturnValue(ready([visit('s1'), visit('s2')]));
    linkInvoiceSessions.mockRejectedValue(new Error('Session(s) not found: s2.'));
    const onSaved = vi.fn();
    render(
      <InvoiceLinkVisitsEditor invoiceId="inv1" kinfolkId="kf1" linkedIds={['s1']} onCancel={vi.fn()} onSaved={onSaved} />,
    );
    await user.click(box('s2'));
    await user.click(saveButton());

    expect(await screen.findByText('Could not save: Session(s) not found: s2.')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Link visits' })).toBeInTheDocument();
    expect(box('s1').checked).toBe(true);
    expect(box('s2').checked).toBe(true);
    expect(box('s2').disabled).toBe(false);
    expect(saveButton().disabled).toBe(false);
    expect(saveButton()).toHaveTextContent('Save');
  });

  it('a household-less invoice still lists its linked ids so they can be unlinked', () => {
    render(
      <InvoiceLinkVisitsEditor invoiceId="inv1" kinfolkId="  " linkedIds={['s7']} onCancel={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(useCollection).not.toHaveBeenCalled();
    expect(screen.getByText(/names no household/)).toBeInTheDocument();
    expect((screen.getByRole('checkbox', { name: 'Link visit s7' }) as HTMLInputElement).checked).toBe(true);
  });

  it('says the household list failed rather than showing an empty list', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'permission-denied' });
    render(
      <InvoiceLinkVisitsEditor invoiceId="inv1" kinfolkId="kf1" linkedIds={[]} onCancel={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/permission-denied/);
    expect(screen.queryByText(/no visits on record/)).toBeNull();
  });

  it('Cancel calls back without a save', async () => {
    const user = userEvent.setup();
    useCollection.mockReturnValue(ready([visit('s1')]));
    const onCancel = vi.fn();
    render(
      <InvoiceLinkVisitsEditor invoiceId="inv1" kinfolkId="kf1" linkedIds={[]} onCancel={onCancel} onSaved={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(linkInvoiceSessions).not.toHaveBeenCalled();
  });
});

describe('onOtherInvoice', () => {
  it('treats absent, empty and whitespace as unclaimed', () => {
    expect(onOtherInvoice({ invoiceId: undefined }, 'inv1')).toBe(false);
    expect(onOtherInvoice({ invoiceId: '' }, 'inv1')).toBe(false);
    expect(onOtherInvoice({ invoiceId: '   ' }, 'inv1')).toBe(false);
    expect(onOtherInvoice({ invoiceId: 'inv1' }, 'inv1')).toBe(false);
    expect(onOtherInvoice({ invoiceId: 'inv2' }, 'inv1')).toBe(true);
  });
});

describe('linkVisitsSavedText', () => {
  it('names what the server changed, in the desktop wording', () => {
    expect(linkVisitsSavedText({ added: [], removed: [] })).toBe('Linked visits unchanged.');
    expect(linkVisitsSavedText({ added: ['a', 'b'], removed: [] })).toBe('Visits saved: 2 linked.');
    expect(linkVisitsSavedText({ added: ['a'], removed: ['b'] })).toBe('Visits saved: 1 linked, 1 unlinked.');
  });
});
describe('#2091 linking says it does not add a price', () => {
  it('says nothing until a new visit is ticked, then warns before Save', async () => {
    useCollection.mockReturnValue(ready([visit('s1', { invoiceId: 'inv1' }), visit('s2')]));
    render(
      <InvoiceLinkVisitsEditor invoiceId="inv1" kinfolkId="kf1" linkedIds={['s1']} onCancel={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.queryByText(LINK_ADDS_NO_PRICE_TITLE)).toBeNull();
    await userEvent.click(box('s2'));
    expect(screen.getByText(LINK_ADDS_NO_PRICE_TITLE)).toBeInTheDocument();
    expect(screen.getByText(LINK_ADDS_NO_PRICE_TEXT)).toBeInTheDocument();
    // Unticking it again takes the warning away: an unlink adds nothing to warn about.
    await userEvent.click(box('s2'));
    expect(screen.queryByText(LINK_ADDS_NO_PRICE_TITLE)).toBeNull();
  });
  it('an unlink alone does not warn about prices', async () => {
    useCollection.mockReturnValue(ready([visit('s1', { invoiceId: 'inv1' })]));
    render(
      <InvoiceLinkVisitsEditor invoiceId="inv1" kinfolkId="kf1" linkedIds={['s1']} onCancel={vi.fn()} onSaved={vi.fn()} />,
    );
    await userEvent.click(box('s1'));
    expect(screen.queryByText(LINK_ADDS_NO_PRICE_TITLE)).toBeNull();
  });
  it('a visit a line on this invoice bills stays ticked and cannot be unticked', async () => {
    useCollection.mockReturnValue(ready([visit('s1', { invoiceId: 'inv1' }), visit('s2', { invoiceId: 'inv1' })]));
    render(
      <InvoiceLinkVisitsEditor
        invoiceId="inv1"
        kinfolkId="kf1"
        linkedIds={['s1', 's2']}
        billedIds={['s1']}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(box('s1').checked).toBe(true);
    expect(box('s1').disabled).toBe(true);
    expect(screen.getByText(/billed on a line of this invoice, remove the line in Edit to unlink it/)).toBeInTheDocument();
    // A linked visit with no line is still free to unlink.
    expect(box('s2').disabled).toBe(false);
  });
  it('on a locked invoice the billed visit does not point to Edit', () => {
    useCollection.mockReturnValue(ready([visit('s1', { invoiceId: 'inv1' })]));
    render(
      <InvoiceLinkVisitsEditor
        invoiceId="inv1"
        kinfolkId="kf1"
        linkedIds={['s1']}
        billedIds={['s1']}
        linesEditable={false}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(box('s1').disabled).toBe(true);
    expect(screen.getByText(/billed on a line of this invoice, and its lines are locked/)).toBeInTheDocument();
    expect(screen.queryByText(/remove the line in Edit/)).toBeNull();
  });
  it('the save sends the full set and reports the server answer, price note included', async () => {
    useCollection.mockReturnValue(ready([visit('s2')]));
    const onSaved = vi.fn();
    linkInvoiceSessions.mockResolvedValue(result({ sessionIds: ['s2'], added: ['s2'], linkedWithoutLine: ['s2'] }));
    render(<InvoiceLinkVisitsEditor invoiceId="inv1" kinfolkId="kf1" linkedIds={[]} onCancel={vi.fn()} onSaved={onSaved} />);
    await userEvent.click(box('s2'));
    await userEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(linkVisitsSavedText(onSaved.mock.calls[0]![0] as LinkInvoiceSessionsResult)).toBe(
      'Visits saved: 1 linked. The linked visit no longer shows as un-invoiced, and its price was not added to this invoice.',
    );
  });
  it('linkVisitsSavedText: the price note covers only visits added with no line', () => {
    expect(linkVisitsSavedText({ added: ['a', 'b'], removed: [], linkedWithoutLine: ['a', 'b', 'old'] })).toBe(
      'Visits saved: 2 linked. The 2 linked visits no longer show as un-invoiced, and their prices were not added to this invoice.',
    );
    // Already linked without a line before this save: not news, not repeated.
    expect(linkVisitsSavedText({ added: [], removed: ['x'], linkedWithoutLine: ['old'] })).toBe('Visits saved: 1 unlinked.');
    expect(linkVisitsSavedText({ added: ['a'], removed: [], linkedWithoutLine: [] })).toBe('Visits saved: 1 linked.');
  });
});
