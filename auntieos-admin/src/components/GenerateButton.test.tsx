// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GenerateButton } from './GenerateButton';

const { generateDraft } = vi.hoisted(() => ({ generateDraft: vi.fn() }));
vi.mock('../api/communicateGenerate', async (importActual) => {
  const actual = await importActual<typeof import('../api/communicateGenerate')>();
  return { ...actual, generateDraft };
});

const OK = {
  generated_copy: 'Nova met me at the door.',
  generated_title: 'Nova Meets the Door',
  communication_type: 'visit_report',
  kinfolk_name: 'Dana',
  kinfolk_id: 'kf1',
  draft_id: 'd1',
  model: 'claude-sonnet-4-5',
  draftWriteFailed: false,
  warnings: [],
};

function setup(overrides: Partial<React.ComponentProps<typeof GenerateButton>> = {}) {
  const onGenerated = vi.fn();
  const onError = vi.fn();
  render(
    <GenerateButton
      communicationType="visit_report"
      recipient="Dana"
      rawNotes="fed Nova and Otis"
      onGenerated={onGenerated}
      onError={onError}
      {...overrides}
    />,
  );
  return { onGenerated, onError };
}

beforeEach(() => {
  generateDraft.mockReset();
  generateDraft.mockResolvedValue(OK);
});

describe('GenerateButton', () => {
  it('hands the generated body and title back to the caller', async () => {
    const user = userEvent.setup();
    const { onGenerated } = setup();

    await user.click(screen.getByRole('button', { name: 'Ask Auntie' }));

    await waitFor(() =>
      expect(onGenerated).toHaveBeenCalledWith({
        body: 'Nova met me at the door.',
        title: 'Nova Meets the Door',
        draftWriteFailed: false,
      }),
    );
  });

  it('only asks for a title when the caller has somewhere to put one', async () => {
    const user = userEvent.setup();
    setup({ wantTitle: true });

    await user.click(screen.getByRole('button', { name: 'Ask Auntie' }));
    await waitFor(() => expect(generateDraft).toHaveBeenCalled());
    expect(generateDraft.mock.calls[0]?.[0]).toMatchObject({ want_title: true });
  });

  it('omits want_title entirely when not asked for, so no second model call is paid for', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: 'Ask Auntie' }));
    await waitFor(() => expect(generateDraft).toHaveBeenCalled());
    expect(generateDraft.mock.calls[0]?.[0]).not.toHaveProperty('want_title');
  });

  // Blank recipient is legal since the backend stopped requiring it. This is the
  // regression guard for the Blog/Broadcast 400.
  it('sends a blank recipient rather than refusing to call', async () => {
    const user = userEvent.setup();
    setup({ recipient: '', communicationType: 'blog_post' });

    await user.click(screen.getByRole('button', { name: 'Ask Auntie' }));
    await waitFor(() => expect(generateDraft).toHaveBeenCalled());
    expect(generateDraft.mock.calls[0]?.[0]).toMatchObject({ recipient: '', communication_type: 'blog_post' });
  });

  it('asks for notes instead of calling with nothing to work from', async () => {
    const user = userEvent.setup();
    const { onError } = setup({ rawNotes: '   ' });

    await user.click(screen.getByRole('button', { name: 'Ask Auntie' }));

    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/jot a few notes/i));
    expect(generateDraft).not.toHaveBeenCalled();
  });

  it('feeds the previous opening back on a regenerate so the model varies it', async () => {
    const user = userEvent.setup();
    setup({ currentBody: 'Nova met me at the door. Then Otis appeared.' });

    await user.click(screen.getByRole('button', { name: 'Ask Auntie again' }));
    await waitFor(() => expect(generateDraft).toHaveBeenCalled());
    expect(generateDraft.mock.calls[0]?.[0].avoid_opening).toBe('Nova met me at the door.');
  });

  it('names the backend failure rather than a generic message', async () => {
    generateDraft.mockRejectedValue(new Error('generate_rate_limit_exceeded'));
    const user = userEvent.setup();
    const { onError, onGenerated } = setup();

    await user.click(screen.getByRole('button', { name: 'Ask Auntie' }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith('generate_rate_limit_exceeded'));
    expect(onGenerated).not.toHaveBeenCalled();
  });

  it('re-enables after a failure so the operator can retry', async () => {
    generateDraft.mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    setup();

    const button = screen.getByRole('button', { name: 'Ask Auntie' });
    await user.click(button);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Ask Auntie' })).toBeEnabled());
  });
});
