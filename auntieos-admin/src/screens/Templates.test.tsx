// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type TemplateSummary } from '../api/templates';

const { listTemplates, listTemplateCategories } = vi.hoisted(() => ({
  listTemplates: vi.fn(),
  listTemplateCategories: vi.fn(),
}));
vi.mock('../api/templates', async (orig) => ({
  ...(await orig<typeof import('../api/templates')>()),
  // The New Binding dialog calls listTemplates directly.
  listTemplates,
  // The bank list calls the paginated variant. Wrap the array-returning
  // `listTemplates` mock into a page envelope so existing per-test setup
  // (listTemplates.mockResolvedValue([...])) keeps driving it unchanged; a test
  // can instead resolve an explicit { templates, nextCursor } to drive Load more.
  listTemplatesPage: (args: unknown) =>
    Promise.resolve(listTemplates(args)).then((r: unknown) =>
      Array.isArray(r) ? { templates: r, nextCursor: null } : r,
    ),
  listTemplateCategories,
}));

const { saveTemplate, deleteTemplate, assignTemplatesToCategory } = vi.hoisted(() => ({
  saveTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  assignTemplatesToCategory: vi.fn(),
}));
vi.mock('../api/templatesWrite', async () => {
  const actual = await vi.importActual<typeof import('../api/templatesWrite')>(
    '../api/templatesWrite',
  );
  return {
    saveTemplate,
    deleteTemplate,
    assignTemplatesToCategory,
    // Real, not stubbed: TemplateEditor uses it to tell the live-key warning
    // apart from a binding refusal, and a stub would only agree with itself.
    isLiveNotificationKeyWarning: actual.isLiveNotificationKeyWarning,
  };
});

import { Templates } from './Templates';
import { TEMPLATE_BANK_EMPTY_COPY } from '../lib/templateFormat';

function tpl(over: Partial<TemplateSummary>): TemplateSummary {
  return {
    templateId: 'booking.confirmed',
    subject: 'Your booking is confirmed',
    body: 'Hi {{kinfolk_name}}',
    html: null,
    title: 'Booking Confirmed',
    description: null,
    tags: [],
    category: null,
    usageInstructions: '',
    sectionDefinitions: [],
    ...over,
  };
}


/**
 * The editor is a sibling view since the #755 sweep (a page with the mock's
 * "Template bank / Edit template" crumb trail), so "the editor is open" is the
 * crumb marked current and the bank's own heading gone, and "closed" is the
 * bank heading back.
 */
function editorCrumb(label: 'Edit template' | 'New template'): HTMLElement {
  const crumb = screen.getByText(label);
  expect(crumb).toHaveAttribute('aria-current', 'page');
  return crumb;
}
function expectBankShowing(): void {
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Template Bank.');
}

beforeEach(() => {
  listTemplates.mockReset();
  listTemplateCategories.mockReset();
  listTemplateCategories.mockResolvedValue([]);
  saveTemplate.mockReset();
});

describe('Templates screen', () => {
  it('loads and renders rows with title, key, subject, category, and tags', async () => {
    listTemplates.mockResolvedValue([
      tpl({
        templateId: 'booking.confirmed',
        title: 'Booking Confirmed',
        subject: 'Your booking is confirmed',
        category: 'Booking',
        tags: ['booking', 'confirmation'],
      }),
    ]);
    listTemplateCategories.mockResolvedValue(['Booking']);
    render(<Templates />);
    expect(await screen.findByText('Booking Confirmed')).toBeInTheDocument();
    const card = screen.getByText('Booking Confirmed').closest('.templates__card') as HTMLElement;
    expect(within(card).getByText('booking.confirmed')).toBeInTheDocument();
    expect(within(card).getByText('Your booking is confirmed')).toBeInTheDocument();
    // The category and the tags are the kit's compact capsule, purple and
    // orange, not two chips of this screen's own (#755).
    const category = within(card).getByText('Booking', { selector: '.den-statuspill' });
    expect(category).toHaveClass('den-statuspill--compact');
    expect(category).toHaveAttribute('data-tone', 'purple');
    for (const tag of ['booking', 'confirmation']) {
      const pill = within(card).getByText(tag, { selector: '.den-statuspill' });
      expect(pill).toHaveClass('den-statuspill--compact');
      expect(pill).toHaveAttribute('data-tone', 'orange');
    }
    expect(card.querySelector('.templates__chip')).toBeNull();
  });
  /**
   * #755, the skin. The mock's `.tcard` rises on hover, so the card wears the
   * shared `lift`; the band carries the mock's mail tile in its `leading`
   * slot; the explanation is the mock's own sentence, behind the info button
   * rather than under the title.
   */
  it('draws the mock hero: the mail tile before the title, and the mock sentence as the tooltip', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed' })]);
    const { container } = render(<Templates />);
    await screen.findByText('Booking Confirmed');
    const heading = container.querySelector('.den-heading') as HTMLElement;
    expect(within(heading).getByText('The Den · Admin')).toHaveClass('den-heading-kicker');
    const leading = heading.querySelector('.den-heading-leading');
    expect(leading?.querySelector('.templates__hero-tile')).not.toBeNull();
    // The tile comes before the title block, the way the mock's `.micon` does.
    const title = screen.getByRole('heading', { level: 1 });
    expect((leading as Node).compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent(
      'Browse, preview, and edit email templates.',
    );
    expect(screen.queryByText('Browse the email templates SendGrid delivers.')).toBeNull();
  });
  it('every card wears the shared lift, because the whole card opens the editor', async () => {
    listTemplates.mockResolvedValue([
      tpl({ templateId: 'a', title: 'A' }),
      tpl({ templateId: 'b', title: 'B' }),
    ]);
    render(<Templates />);
    await screen.findByText('A');
    const grid = screen.getByRole('list', { name: 'Templates' });
    for (const card of within(grid).getAllByRole('listitem')) {
      expect(card).toHaveClass('templates__card', 'lift');
    }
  });
  it('draws the magnifier inside the search box, before the input', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'a', title: 'A' })]);
    render(<Templates />);
    await screen.findByText('A');
    const input = screen.getByLabelText(/search templates by title or key/i);
    const box = input.closest('.templates__search') as HTMLElement;
    const glyph = box.querySelector('.templates__search-glyph');
    expect(glyph).not.toBeNull();
    expect((glyph as Node).compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('surfaces a load failure naming the callable, never a false empty list', async () => {
    // Both the primary AsyncRegion panel AND the Templates/Untagged stat
    // cards derive from the same failed `templates` load, so each honestly
    // shows its OWN error (asyncScalar never fabricates a fallback number) :
    // the same "every derived value tells the truth" pattern Invoices.tsx's
    // outstandingTotal/billedTotal/overdueCount cards follow. Scope to the
    // panel's own error detail, matching KinTales.test.tsx's convention.
    listTemplates.mockRejectedValue(new Error('permission-denied'));
    render(<Templates />);
    expect(
      await screen.findByText(/listTemplates failed: permission-denied/, { selector: '.async-error-detail' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(TEMPLATE_BANK_EMPTY_COPY)).toBeNull();
  });

  it('retries the load on demand', async () => {
    listTemplates.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([tpl({})]);
    render(<Templates />);
    await screen.findByText(/listTemplates failed/i, { selector: '.async-error-detail' });
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Booking Confirmed')).toBeInTheDocument();
    expect(listTemplates).toHaveBeenCalledTimes(2);
  });

  it('renders the proven-empty state, not while the load is failing', async () => {
    listTemplates.mockResolvedValue([]);
    render(<Templates />);
    expect(await screen.findByText(TEMPLATE_BANK_EMPTY_COPY)).toBeInTheDocument();
  });

  it('surfaces a categories load failure as a secondary note, without blanking the template list', async () => {
    listTemplates.mockResolvedValue([tpl({})]);
    listTemplateCategories.mockRejectedValue(new Error('unavailable'));
    render(<Templates />);
    expect(await screen.findByText('Booking Confirmed')).toBeInTheDocument();
    expect(await screen.findByText(/categories unavailable/i)).toBeInTheDocument();
  });

  it('filters rows by category tab, and the tab carries a live count', async () => {
    listTemplates.mockResolvedValue([
      tpl({ templateId: 'a', title: 'Booking A', category: 'Booking' }),
      tpl({ templateId: 'b', title: 'Reminder B', category: 'Reminder' }),
    ]);
    listTemplateCategories.mockResolvedValue(['Booking', 'Reminder']);
    render(<Templates />);
    await screen.findByText('Booking A');

    const bookingTab = screen.getByRole('tab', { name: /booking 1/i });
    await userEvent.click(bookingTab);

    expect(screen.getByText('Booking A')).toBeInTheDocument();
    expect(screen.queryByText('Reminder B')).toBeNull();
  });

  it('an uncategorized template only shows under All, never under a specific category tab', async () => {
    listTemplates.mockResolvedValue([
      tpl({ templateId: 'a', title: 'Booking A', category: 'Booking' }),
      tpl({ templateId: 'b', title: 'No Category B', category: null }),
    ]);
    listTemplateCategories.mockResolvedValue(['Booking']);
    render(<Templates />);
    await screen.findByText('Booking A');
    expect(screen.getByText('No Category B')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /booking 1/i }));
    expect(screen.queryByText('No Category B')).toBeNull();

    await userEvent.click(screen.getByRole('tab', { name: /^all/i }));
    expect(screen.getByText('No Category B')).toBeInTheDocument();
  });

  it('filters the visible rows by the search box (title or key)', async () => {
    listTemplates.mockResolvedValue([
      tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed' }),
      tpl({ templateId: 'invoice.reminder', title: 'Invoice Reminder' }),
    ]);
    render(<Templates />);
    await screen.findByText('Booking Confirmed');
    await userEvent.type(screen.getByLabelText(/search templates/i), 'invoice');
    expect(screen.queryByText('Booking Confirmed')).toBeNull();
    expect(screen.getByText('Invoice Reminder')).toBeInTheDocument();
  });

  it('calls an externally supplied onSelect with the templateId instead of opening the built-in editor', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed' })]);
    const onSelect = vi.fn();
    render(<Templates onSelect={onSelect} />);
    await userEvent.click(await screen.findByText('Booking Confirmed'));
    expect(onSelect).toHaveBeenCalledWith('booking.confirmed');
    expectBankShowing();
  });

  /**
   * The list-shape rule (operator ruling 2026-08-06 "04 CARDS", written out in
   * `docs/2026-05-31-den-redesign-design.md`): the Template Bank browses peer
   * entities, so it is a card grid, not a stacked column. Its own mock has said
   * so since 2026-05-27 (`ui-ideas/auntieos-template-bank-2026-05-27.html`
   * l.108, `repeat(auto-fill, minmax(310px, 1fr))`); the React port shipped the
   * column anyway, which is the drift this closes.
   *
   * jsdom has no layout, so this asserts the carriers: the shared grid is
   * present and named, and it is carrying THIS screen's mock width rather than
   * the shared default.
   */
  it('browses templates as a named card grid at the width its mock draws', async () => {
    listTemplates.mockResolvedValue([
      tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed' }),
      tpl({ templateId: 'welcome.kinfolk', title: 'Welcome' }),
    ]);
    render(<Templates />);

    const grid = await screen.findByRole('list', { name: 'Templates' });
    expect(grid).toHaveClass('entity-grid');
    expect(grid.style.getPropertyValue('--entity-card-min')).toBe('310px');
    expect(within(grid).getAllByRole('listitem')).toHaveLength(2);
  });

  /**
   * #716, the page frame. The mock is a flat page: heading, one controls row,
   * grid. The live screen had grown a stat strip and a titled panel around the
   * list, so the operator read the page title twice and met three cards of
   * counts before the first template.
   *
   * jsdom has no layout, so these assert the carriers: the elements that used
   * to be there are gone, and the two controls share one row element.
   */
  it('draws no stat strip: the mock has none, and the chips already carry the counts', async () => {
    listTemplates.mockResolvedValue([
      tpl({ templateId: 'a', title: 'A', tags: [] }),
      tpl({ templateId: 'b', title: 'B', tags: ['x'] }),
    ]);
    listTemplateCategories.mockResolvedValue(['Booking']);
    const { container } = render(<Templates />);
    await screen.findByText('A');

    expect(container.querySelectorAll('.den-stat')).toHaveLength(0);
    expect(screen.queryByText('Untagged', { selector: '.den-stat-label' })).toBeNull();
    // The count the strip used to claim is still on screen, on the All chip.
    expect(screen.getByRole('tab', { name: /^all 2/i })).toBeInTheDocument();
  });

  it('puts the grid straight on the page: no panel, and the page is titled once', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed' })]);
    render(<Templates />);
    const grid = await screen.findByRole('list', { name: 'Templates' });

    expect(grid.closest('.den-panel')).toBeNull();
    // One heading for the page, and no second "Templates" title under it.
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    expect(screen.getByRole('heading')).toHaveTextContent(/Template\s*Bank\./);
  });

  it('keeps the category chips and the search box on one controls row', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed' })]);
    listTemplateCategories.mockResolvedValue(['Booking']);
    render(<Templates />);
    await screen.findByText('Booking Confirmed');

    const tablist = screen.getByRole('tablist', { name: /filter templates by category/i });
    const search = screen.getByLabelText(/search templates by title or key/i).closest('.templates__search');
    const row = tablist.closest('.templates__controls');

    expect(row).not.toBeNull();
    expect(search?.closest('.templates__controls')).toBe(row);
    // The search sits after the chips, which is what puts it on the right edge.
    expect(tablist.compareDocumentPosition(search as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('cards are always live buttons: with no onSelect override, activating a card opens the built-in editor', async () => {
    // Unlike the pre-editor placeholder, there is no unwired/dead-control case
    // left: the router mounts <Templates/> propless in production, so this
    // default (opening the editor page) is what every operator actually gets.
    listTemplates.mockResolvedValue([
      tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed', subject: 'Your booking is confirmed' }),
    ]);
    render(<Templates />);
    const row = await screen.findByText('Booking Confirmed');
    expect(row.closest('.templates__card-main')?.tagName).toBe('BUTTON');
    await userEvent.click(row);
    editorCrumb('Edit template');
    expect(screen.getByLabelText(/^subject$/i)).toHaveValue('Your booking is confirmed');
  });

  /**
   * #716, the card footer. The mock's card ends in a right-aligned "Edit"
   * ghost button, and this card had none: the comment that chose that said a
   * footer button would only repeat the card tap. The operator marked the
   * missing footer, so the button ships, and both routes open the editor.
   */
  it('the card footer Edit button opens the same editor the card body opens', async () => {
    listTemplates.mockResolvedValue([
      tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed', subject: 'Your booking is confirmed' }),
    ]);
    render(<Templates />);
    const card = (await screen.findByText('Booking Confirmed')).closest('.templates__card') as HTMLElement;

    const edit = within(card).getByRole('button', { name: 'Edit' });
    expect(edit.closest('.templates__card-foot')).not.toBeNull();
    // Its own control, not a button nested inside the card button.
    expect(edit.closest('.templates__card-main')).toBeNull();

    await userEvent.click(edit);

    editorCrumb('Edit template');
    expect(screen.getByLabelText(/^subject$/i)).toHaveValue('Your booking is confirmed');
  });

  it('the footer Edit button honours an onSelect override, exactly as the card body does', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed' })]);
    const onSelect = vi.fn();
    render(<Templates onSelect={onSelect} />);
    const card = (await screen.findByText('Booking Confirmed')).closest('.templates__card') as HTMLElement;

    await userEvent.click(within(card).getByRole('button', { name: 'Edit' }));

    expect(onSelect).toHaveBeenCalledWith('booking.confirmed');
    expectBankShowing();
  });

  it('labels the subject line "Subject:", the way the mock does', async () => {
    listTemplates.mockResolvedValue([
      tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed', subject: 'Your booking is confirmed' }),
    ]);
    render(<Templates />);
    const card = (await screen.findByText('Booking Confirmed')).closest('.templates__card') as HTMLElement;

    const line = card.querySelector('.templates__card-subject') as HTMLElement;
    expect(line.textContent?.replace(/\s+/g, ' ').trim()).toBe('Subject: Your booking is confirmed');
  });

  it('does not label a template that has no subject: the fallback already says so', async () => {
    listTemplates.mockResolvedValue([
      tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed', subject: '   ' }),
    ]);
    render(<Templates />);
    const card = (await screen.findByText('Booking Confirmed')).closest('.templates__card') as HTMLElement;

    const line = card.querySelector('.templates__card-subject') as HTMLElement;
    expect(line.textContent?.replace(/\s+/g, ' ').trim()).toBe('No subject set');
  });

  it('New template opens the built-in editor in create mode by default', async () => {
    listTemplates.mockResolvedValue([]);
    render(<Templates />);
    await screen.findByText(TEMPLATE_BANK_EMPTY_COPY);
    await userEvent.click(screen.getByRole('button', { name: /new template/i }));
    editorCrumb('New template');
    expect(screen.getByLabelText(/template key/i)).toHaveValue('');
  });

  it('an externally supplied onNew overrides the built-in New template default', async () => {
    listTemplates.mockResolvedValue([]);
    const onNew = vi.fn();
    render(<Templates onNew={onNew} />);
    await screen.findByText(TEMPLATE_BANK_EMPTY_COPY);
    await userEvent.click(screen.getByRole('button', { name: /new template/i }));
    expect(onNew).toHaveBeenCalledOnce();
    expectBankShowing();
  });

  it('saving a new template closes the editor and reloads the list', async () => {
    listTemplates.mockResolvedValueOnce([]);
    listTemplates.mockResolvedValueOnce([
      tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed' }),
    ]);
    saveTemplate.mockResolvedValue({ templateId: 'booking.confirmed' });
    render(<Templates />);
    await screen.findByText(TEMPLATE_BANK_EMPTY_COPY);

    await userEvent.click(screen.getByRole('button', { name: /new template/i }));
    await userEvent.type(screen.getByLabelText(/template key/i), 'booking.confirmed');
    await userEvent.type(screen.getByLabelText(/^subject$/i), 'Your booking is confirmed');
    await userEvent.type(screen.getByLabelText(/^body$/i), 'Hi {{kinfolk_name}}');
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));

    await waitFor(() => expectBankShowing());
    await waitFor(() => expect(listTemplates).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Booking Confirmed')).toBeInTheDocument();
  });

  it('deleting a template through the editor closes it and reloads the list', async () => {
    listTemplates.mockResolvedValueOnce([
      tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed', subject: 'Your booking is confirmed' }),
    ]);
    listTemplates.mockResolvedValueOnce([]);
    deleteTemplate.mockResolvedValue({ templateId: 'booking.confirmed' });
    render(<Templates />);

    const row = await screen.findByText('Booking Confirmed');
    await userEvent.click(row);
    editorCrumb('Edit template');

    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(screen.getByRole('dialog', { name: /delete this template\?/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /delete template/i }));

    expect(deleteTemplate).toHaveBeenCalledWith('booking.confirmed', {
      acknowledgeLiveKey: false,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expectBankShowing());
    await waitFor(() => expect(listTemplates).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(TEMPLATE_BANK_EMPTY_COPY)).toBeInTheDocument();
  });

  it('a stale/missing row id (list not yet loaded) is a silent no-op, never a crash or a blank editor', async () => {
    listTemplates.mockReturnValue(new Promise(() => {})); // never resolves: still loading
    render(<Templates />);
    // Nothing to click yet (AsyncRegion is showing the loading state), so this
    // exercises openEditorFor's guard indirectly via New template still being
    // available and NOT throwing while templates.status !== 'ready'.
    await userEvent.click(screen.getByRole('button', { name: /new template/i }));
    editorCrumb('New template');
  });

  it('the editor replaces the bank while it is open, and the Template bank crumb brings the bank back', async () => {
    listTemplates.mockResolvedValue([
      tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed' }),
    ]);
    render(<Templates />);
    await userEvent.click(await screen.findByText('Booking Confirmed'));
    // One page at a time: no bank heading, no card grid, one h1.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByText('Template Bank.')).toBeNull();
    expect(document.querySelector('.templates__card')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Template bank' }));
    expectBankShowing();
    expect(await screen.findByText('Booking Confirmed')).toBeInTheDocument();
  });
  it('every category chip carries its own live count', async () => {
    listTemplates.mockResolvedValue([
      tpl({ templateId: 'a', title: 'A', category: 'Booking' }),
      tpl({ templateId: 'b', title: 'B', category: null }),
    ]);
    listTemplateCategories.mockResolvedValue(['Booking']);
    render(<Templates />);
    await screen.findByText('A');

    expect(screen.getByRole('tab', { name: /^all 2/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^booking 1/i })).toBeInTheDocument();
  });
});

/**
 * #716, the header. The mock draws one action. The three secondary flows are
 * real and stay reachable, one level down.
 */
describe('Templates screen: one primary header action, the rest behind a menu', () => {
  beforeEach(() => {
    listTemplates.mockReset();
    listTemplateCategories.mockReset();
    listTemplateCategories.mockResolvedValue([]);
    listTemplates.mockResolvedValue([tpl({ templateId: 'a', title: 'Alpha' })]);
  });

  it('shows New template and one menu trigger, and no other header buttons', async () => {
    render(<Templates />);
    await screen.findByText('Alpha');

    const trailing = document.querySelector('.den-heading-trailing') as HTMLElement;
    const buttons = within(trailing).getAllByRole('button').map((b) => b.textContent?.trim());
    expect(buttons).toEqual(['More actions', 'New template']);

    // Closed until asked for: the three flows are not lined up on the heading.
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByText('Manage assignments')).toBeNull();
  });

  it('the menu exposes all three secondary flows', async () => {
    render(<Templates />);
    await screen.findByText('Alpha');

    const trigger = screen.getByRole('button', { name: /more actions/i });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Manage assignments', 'Import from repo', 'New binding']);
  });

  it('Manage assignments opens the assignment manager', async () => {
    render(<Templates />);
    await screen.findByText('Alpha');

    await userEvent.click(screen.getByRole('button', { name: /more actions/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /manage assignments/i }));

    expect(await screen.findByRole('button', { name: /back to template bank/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Template\s*Routing/);
  });

  it('Import from repo opens the importer', async () => {
    render(<Templates />);
    await screen.findByText('Alpha');

    await userEvent.click(screen.getByRole('button', { name: /more actions/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /import from repo/i }));

    expect(await screen.findByRole('button', { name: /back to template bank/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Import\s*templates\./);
  });

  it('Escape closes the menu and hands focus back to the trigger', async () => {
    render(<Templates />);
    await screen.findByText('Alpha');

    const trigger = screen.getByRole('button', { name: /more actions/i });
    await userEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

describe('Templates screen: I8 pagination', () => {
  beforeEach(() => {
    listTemplates.mockReset();
    listTemplateCategories.mockReset();
    listTemplateCategories.mockResolvedValue([]);
  });

  it('shows Load more when the first page returns a cursor, and appends the next page on click', async () => {
    listTemplates
      .mockResolvedValueOnce({ templates: [tpl({ templateId: 'a', title: 'Alpha' })], nextCursor: 'a' })
      .mockResolvedValueOnce({ templates: [tpl({ templateId: 'b', title: 'Beta' })], nextCursor: null });
    render(<Templates />);

    await screen.findByText('Alpha');
    expect(screen.queryByText('Beta')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /load more/i }));

    expect(await screen.findByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument(); // previous page still shown
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });

  it('shows no Load more when the first page is exhausted (nextCursor null)', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'a', title: 'Alpha' })]);
    render(<Templates />);
    await screen.findByText('Alpha');
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });

  it('surfaces a Load more failure fail-loud, keeping the already-loaded rows', async () => {
    listTemplates
      .mockResolvedValueOnce({ templates: [tpl({ templateId: 'a', title: 'Alpha' })], nextCursor: 'a' })
      .mockRejectedValueOnce(new Error('permission-denied'));
    render(<Templates />);
    await screen.findByText('Alpha');

    await userEvent.click(screen.getByRole('button', { name: /load more/i }));

    expect(await screen.findByText(/listTemplates failed: permission-denied/)).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });
});

describe('Templates screen: I9 New binding', () => {
  beforeEach(() => {
    listTemplates.mockReset();
    listTemplateCategories.mockReset();
    listTemplateCategories.mockResolvedValue(['Booking']);
  });

  it('opens the bulk category (New binding) dialog from the header menu', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'a', title: 'Alpha' })]);
    render(<Templates />);
    await screen.findByText('Alpha');

    await userEvent.click(screen.getByRole('button', { name: /more actions/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /new binding/i }));

    expect(screen.getByRole('dialog', { name: /new binding/i })).toBeInTheDocument();
  });
});
describe('Templates screen: an empty list that says which fact it means', () => {
  beforeEach(() => {
    listTemplates.mockReset();
    listTemplateCategories.mockReset();
    listTemplateCategories.mockResolvedValue([]);
  });
  it('a search that matched nothing over an OPEN cursor admits it only searched the loaded page', async () => {
    listTemplates.mockResolvedValue({
      templates: [tpl({ templateId: 'a', title: 'Alpha' }), tpl({ templateId: 'b', title: 'Beta' })],
      nextCursor: 'b',
    });
    render(<Templates />);
    await screen.findByText('Alpha');
    await userEvent.type(screen.getByLabelText(/search templates by title or key/i), 'refund');
    expect(
      await screen.findByText(
        'Nothing matches "refund". Searched the 2 templates loaded so far, by title and key. Load more to search further.',
      ),
    ).toBeInTheDocument();
    // The control that lifts the bound the message just named is on screen.
    expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument();
  });
  it('a search that matched nothing over an EXHAUSTED list says it searched all of them', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'a', title: 'Alpha' })]);
    render(<Templates />);
    await screen.findByText('Alpha');
    await userEvent.type(screen.getByLabelText(/search templates by title or key/i), 'refund');
    expect(
      await screen.findByText('Nothing matches "refund". Searched all 1 template, by title and key.'),
    ).toBeInTheDocument();
  });
  it('an empty CATEGORY gets the mock\'s empty-state copy, not a failed-search message', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'a', title: 'Alpha', category: 'Onboarding' })]);
    listTemplateCategories.mockResolvedValue(['Onboarding', 'Bookings']);
    render(<Templates />);
    await screen.findByText('Alpha');
    await userEvent.click(screen.getByRole('tab', { name: /^Bookings/ }));
    expect(await screen.findByText(TEMPLATE_BANK_EMPTY_COPY)).toBeInTheDocument();
  });
  it('names the active category in the no-match message, so the two exclusions are told apart', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'a', title: 'Alpha', category: 'Onboarding' })]);
    listTemplateCategories.mockResolvedValue(['Onboarding']);
    render(<Templates />);
    await screen.findByText('Alpha');
    await userEvent.click(screen.getByRole('tab', { name: /^Onboarding/ }));
    await userEvent.type(screen.getByLabelText(/search templates by title or key/i), 'refund');
    expect(
      await screen.findByText(
        'Nothing in Onboarding matches "refund". Searched all 1 template, by title and key.',
      ),
    ).toBeInTheDocument();
  });
  it('a bank with no templates at all still says exactly that', async () => {
    listTemplates.mockResolvedValue([]);
    render(<Templates />);
    expect(await screen.findByText(TEMPLATE_BANK_EMPTY_COPY)).toBeInTheDocument();
  });
});
describe('Templates screen: the mock\'s Ctrl-K search shortcut', () => {
  beforeEach(() => {
    listTemplates.mockReset();
    listTemplateCategories.mockReset();
    listTemplateCategories.mockResolvedValue([]);
  });
  it('draws the hint the mock draws, beside the search box', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'a', title: 'Alpha' })]);
    render(<Templates />);
    await screen.findByText('Alpha');
    const hint = screen.getByText('Ctrl K');
    expect(hint.tagName).toBe('KBD');
    expect(hint.closest('.templates__search')).not.toBeNull();
  });
  it('Ctrl+K focuses the search box, so the hint is not a dead affordance', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'a', title: 'Alpha' })]);
    render(<Templates />);
    await screen.findByText('Alpha');
    const input = screen.getByLabelText(/search templates by title or key/i);
    expect(input).not.toHaveFocus();
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(input).toHaveFocus();
  });
  it('Cmd+K does the same, because this admin is used on a Mac', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'a', title: 'Alpha' })]);
    render(<Templates />);
    await screen.findByText('Alpha');
    const input = screen.getByLabelText(/search templates by title or key/i);
    await userEvent.keyboard('{Meta>}k{/Meta}');
    expect(input).toHaveFocus();
  });
  it('selects what is already typed, so the shortcut restarts a search instead of appending to it', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'a', title: 'Alpha' })]);
    render(<Templates />);
    await screen.findByText('Alpha');
    const input = screen.getByLabelText(/search templates by title or key/i) as HTMLInputElement;
    await userEvent.type(input, 'alph');
    input.blur();
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('alph'.length);
  });
  it('is inert while the list has not loaded: there is no box to focus, so the key is left to the browser', async () => {
    // The search box lives inside the AsyncRegion ready branch. A failed load
    // renders no input at all, and swallowing Ctrl-K there would steal the
    // browser's own shortcut in exchange for nothing.
    listTemplates.mockRejectedValue(new Error('permission-denied'));
    render(<Templates />);
    await screen.findByText(/listTemplates failed: permission-denied/, { selector: '.async-error-detail' });
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(screen.queryByLabelText(/search templates by title or key/i)).toBeNull();
  });
});
