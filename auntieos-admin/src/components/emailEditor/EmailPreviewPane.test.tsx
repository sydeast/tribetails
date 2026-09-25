// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const { previewEmailTemplate } = vi.hoisted(() => ({ previewEmailTemplate: vi.fn() }));
vi.mock('../../api/templatesWrite', () => ({ previewEmailTemplate }));

import { EmailPreviewPane } from './EmailPreviewPane';
import { PREVIEW_DEBOUNCE_MS, useEmailPreview } from '../../lib/useEmailPreview';
import type { PreviewEmailTemplateRequest } from '../../api/templatesWrite';

function Harness({ req }: { req: PreviewEmailTemplateRequest | null }) {
  const { state, retry } = useEmailPreview(req);
  return <EmailPreviewPane state={state} onRetry={retry} />;
}
const REQ = { subject: 'Hi', headline: 'H', content: '<p>x</p>' };
const RES = { subject: 'Hi Pat', html: '<html><body><h2>H</h2></body></html>', text: 'H\n\nx', issues: [] as string[] };
const pane = () => screen.getByRole('region', { name: 'Preview' });
const tick = async (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('EmailPreviewPane with useEmailPreview', () => {
  it('shows a prompt and calls nothing while there is nothing to preview', async () => {
    render(<Harness req={null} />);
    await tick(PREVIEW_DEBOUNCE_MS * 2);
    expect(screen.getByText('Add a headline and some content to see the email.')).toBeInTheDocument();
    expect(previewEmailTemplate).not.toHaveBeenCalled();
  });

  it('shows the loading cue at once and through a slow answer, then the framed email', async () => {
    let resolve: (r: typeof RES) => void = () => {};
    previewEmailTemplate.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<Harness req={REQ} />);
    expect(pane()).toHaveAttribute('aria-busy', 'true');
    expect(screen.getAllByText('Updating preview…').length).toBeGreaterThan(0);
    await tick(PREVIEW_DEBOUNCE_MS);
    expect(previewEmailTemplate).toHaveBeenCalledWith(REQ);
    await tick(10_000);
    expect(pane()).toHaveAttribute('aria-busy', 'true');
    await act(async () => resolve(RES));
    expect(pane()).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByTitle('The email as it will be sent')).toHaveAttribute('srcdoc', RES.html);
    expect(screen.getByText('Hi Pat')).toBeInTheDocument();
    // The text part sits in a closed <details>; jsdom cannot judge visibility,
    // so assert the carrier and the content, not toBeVisible.
    const details = screen.getByText('Plain-text version').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details.querySelector('pre')!.textContent).toBe('H\n\nx');
  });

  it('debounces: typing bursts send one request, for the latest input', async () => {
    previewEmailTemplate.mockResolvedValue(RES);
    const { rerender } = render(<Harness req={REQ} />);
    await tick(100);
    rerender(<Harness req={{ ...REQ, headline: 'H2' }} />);
    await tick(100);
    rerender(<Harness req={{ ...REQ, headline: 'H3' }} />);
    await tick(PREVIEW_DEBOUNCE_MS);
    expect(previewEmailTemplate).toHaveBeenCalledTimes(1);
    expect(previewEmailTemplate).toHaveBeenCalledWith({ ...REQ, headline: 'H3' });
  });

  it('a late answer to an older request never replaces a newer one', async () => {
    const answers: Array<(r: typeof RES) => void> = [];
    previewEmailTemplate.mockImplementation(() => new Promise((r) => answers.push(r)));
    const { rerender } = render(<Harness req={REQ} />);
    await tick(PREVIEW_DEBOUNCE_MS);
    rerender(<Harness req={{ ...REQ, headline: 'New' }} />);
    await tick(PREVIEW_DEBOUNCE_MS);
    await act(async () => answers[1]!({ ...RES, subject: 'Newest' }));
    await act(async () => answers[0]!({ ...RES, subject: 'Stale' }));
    expect(screen.getByText('Newest')).toBeInTheDocument();
    expect(screen.queryByText('Stale')).toBeNull();
  });

  it('shows a failure with Try again, which asks again', async () => {
    previewEmailTemplate.mockRejectedValueOnce(new Error('previewEmailTemplate took too long to respond.'));
    render(<Harness req={REQ} />);
    await tick(PREVIEW_DEBOUNCE_MS);
    expect(screen.getByText('Couldn’t update the preview')).toBeInTheDocument();
    expect(screen.getByText('previewEmailTemplate took too long to respond.')).toBeInTheDocument();
    previewEmailTemplate.mockResolvedValueOnce(RES);
    await act(async () => screen.getByRole('button', { name: 'Try again' }).click());
    await tick(PREVIEW_DEBOUNCE_MS);
    expect(previewEmailTemplate).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Hi Pat')).toBeInTheDocument();
  });

  it('lists the problems the server found', async () => {
    previewEmailTemplate.mockResolvedValue({ ...RES, issues: ['A merge field was broken apart by formatting. Retype it as one piece.'] });
    render(<Harness req={REQ} />);
    await tick(PREVIEW_DEBOUNCE_MS);
    expect(screen.getByText('Problems found')).toBeInTheDocument();
    expect(screen.getByText('A merge field was broken apart by formatting. Retype it as one piece.')).toBeInTheDocument();
  });
});
