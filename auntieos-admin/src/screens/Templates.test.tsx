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
    expect(within(card).getByText('Booking', { selector: '.templates__chip--category' })).toBeInTheDocument();
    expect(within(card).getByText('booking', { selector: '.templates__chip--tag' })).toBeInTheDocument();
    expect(within(card).getByText('confirmation', { selector: '.templates__chip--tag' })).toBeInTheDocument();
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
    expect(screen.queryByText(/no templates yet/i)).toBeNull();
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
    expect(await screen.findByText(/no templates yet/i)).toBeInTheDocument();
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
    expect(screen.queryByRole('dialog')).toBeNull();
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
   * The panel's instruction has to name the thing the operator can actually
   * click. The list stopped being a stacked column of rows when the card grid
   * landed above, and copy that still says "row" sends the operator looking for
   * a control this screen no longer draws.
   *
   * Asserted on the rendered subtitle rather than on the source string, so a
   * later re-word that reintroduces the row cannot pass by moving the text.
   */
  it('tells the operator to click a card, because rows are not what this screen draws', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed' })]);
    render(<Templates />);
    await screen.findByText('Booking Confirmed');

    const subtitle = screen.getByText(/Filter by category, or search by title or key\./);
    expect(subtitle.textContent).toContain('Click a card to open it.');
    expect(subtitle.textContent).not.toMatch(/\brow\b/i);
  });

  it('cards are always live buttons: with no onSelect override, activating a card opens the built-in editor', async () => {
    // Unlike the pre-editor placeholder, there is no unwired/dead-control case
    // left: the router mounts <Templates/> propless in production, so this
    // default (opening the overlay) is what every operator actually gets.
    listTemplates.mockResolvedValue([
      tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed', subject: 'Your booking is confirmed' }),
    ]);
    render(<Templates />);
    const row = await screen.findByText('Booking Confirmed');
    expect(row.closest('.templates__card-main')?.tagName).toBe('BUTTON');
    await userEvent.click(row);
    expect(screen.getByRole('dialog', { name: /edit template/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^subject$/i)).toHaveValue('Your booking is confirmed');
  });

  it('New template opens the built-in editor in create mode by default', async () => {
    listTemplates.mockResolvedValue([]);
    render(<Templates />);
    await screen.findByText(/no templates yet/i);
    await userEvent.click(screen.getByRole('button', { name: /new template/i }));
    expect(screen.getByRole('dialog', { name: /new template/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/template key/i)).toHaveValue('');
  });

  it('an externally supplied onNew overrides the built-in New template default', async () => {
    listTemplates.mockResolvedValue([]);
    const onNew = vi.fn();
    render(<Templates onNew={onNew} />);
    await screen.findByText(/no templates yet/i);
    await userEvent.click(screen.getByRole('button', { name: /new template/i }));
    expect(onNew).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('saving a new template closes the editor and reloads the list', async () => {
    listTemplates.mockResolvedValueOnce([]);
    listTemplates.mockResolvedValueOnce([
      tpl({ templateId: 'booking.confirmed', title: 'Booking Confirmed' }),
    ]);
    saveTemplate.mockResolvedValue({ templateId: 'booking.confirmed' });
    render(<Templates />);
    await screen.findByText(/no templates yet/i);

    await userEvent.click(screen.getByRole('button', { name: /new template/i }));
    await userEvent.type(screen.getByLabelText(/template key/i), 'booking.confirmed');
    await userEvent.type(screen.getByLabelText(/^subject$/i), 'Your booking is confirmed');
    await userEvent.type(screen.getByLabelText(/^body$/i), 'Hi {{kinfolk_name}}');
    await userEvent.click(screen.getByRole('button', { name: /save template/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
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
    expect(screen.getByRole('dialog', { name: /edit template/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(screen.getByRole('dialog', { name: /delete this template\?/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /delete template/i }));

    expect(deleteTemplate).toHaveBeenCalledWith('booking.confirmed', {
      acknowledgeLiveKey: false,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(listTemplates).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/no templates yet/i)).toBeInTheDocument();
  });

  it('a stale/missing row id (list not yet loaded) is a silent no-op, never a crash or a blank editor', async () => {
    listTemplates.mockReturnValue(new Promise(() => {})); // never resolves: still loading
    render(<Templates />);
    // Nothing to click yet (AsyncRegion is showing the loading state), so this
    // exercises openEditorFor's guard indirectly via New template still being
    // available and NOT throwing while templates.status !== 'ready'.
    await userEvent.click(screen.getByRole('button', { name: /new template/i }));
    expect(screen.getByRole('dialog', { name: /new template/i })).toBeInTheDocument();
  });

  it('shows real counts in the stat strip', async () => {
    listTemplates.mockResolvedValue([
      tpl({ templateId: 'a', title: 'A', tags: [] }),
      tpl({ templateId: 'b', title: 'B', tags: ['x'] }),
    ]);
    listTemplateCategories.mockResolvedValue(['Booking']);
    render(<Templates />);
    await screen.findByText('A');

    // Scoped to each stat card's own container (found via its label), not the
    // tab-count spans or a sibling card, which would otherwise collide on the
    // same digit.
    const templatesCard = screen.getByText('Templates', { selector: '.den-stat-label' }).closest('.den-stat');
    const categoriesCard = screen.getByText('Categories', { selector: '.den-stat-label' }).closest('.den-stat');
    const untaggedCard = screen.getByText('Untagged', { selector: '.den-stat-label' }).closest('.den-stat');

    expect(within(templatesCard as HTMLElement).getByText('2')).toBeInTheDocument();
    expect(within(categoriesCard as HTMLElement).getByText('1')).toBeInTheDocument();
    expect(within(untaggedCard as HTMLElement).getByText('1')).toBeInTheDocument();
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

  it('opens the bulk category (New binding) dialog from the header', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'a', title: 'Alpha' })]);
    render(<Templates />);
    await screen.findByText('Alpha');

    await userEvent.click(screen.getByRole('button', { name: /new binding/i }));

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
  it('an empty CATEGORY is reported as an empty category, not as a failed search', async () => {
    listTemplates.mockResolvedValue([tpl({ templateId: 'a', title: 'Alpha', category: 'Onboarding' })]);
    listTemplateCategories.mockResolvedValue(['Onboarding', 'Bookings']);
    render(<Templates />);
    await screen.findByText('Alpha');
    await userEvent.click(screen.getByRole('tab', { name: /^Bookings/ }));
    expect(await screen.findByText('No templates in Bookings.')).toBeInTheDocument();
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
    expect(await screen.findByText('No templates yet.')).toBeInTheDocument();
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
