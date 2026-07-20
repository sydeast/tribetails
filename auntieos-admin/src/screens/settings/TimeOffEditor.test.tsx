// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TimeOffEditor } from './TimeOffEditor';

const EMPTY = { observedUsHolidays: [], companyHolidays: [], specialHours: [] };

describe('TimeOffEditor', () => {
  it('renders all eleven US holidays, unchecked when none are observed', () => {
    render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
    expect(screen.getByRole('switch', { name: "Toggle New Year's Day observed" })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('switch', { name: 'Toggle Christmas Day observed' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('checks a holiday already in observedUsHolidays', () => {
    render(<TimeOffEditor data={{ ...EMPTY, observedUsHolidays: ['christmas'] }} onSave={vi.fn()} />);
    expect(screen.getByRole('switch', { name: 'Toggle Christmas Day observed' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('toggling a holiday enables Save and saves the id in observedUsHolidays', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TimeOffEditor data={EMPTY} onSave={onSave} />);
    const saveBtn = screen.getByRole('button', { name: /^save$/i });
    expect(saveBtn).toBeDisabled();
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Juneteenth observed' }));
    expect(saveBtn).toBeEnabled();
    await userEvent.click(saveBtn);
    expect(onSave).toHaveBeenCalledWith({
      observedUsHolidays: ['juneteenth'],
      companyHolidays: [],
      specialHours: [],
    });
  });

  it('lists existing company holidays parsed from the date|label wire format', () => {
    render(
      <TimeOffEditor
        data={{ ...EMPTY, companyHolidays: ['2026-12-25|Christmas closure'] }}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText('Christmas closure')).toBeInTheDocument();
    expect(screen.getByText('2026-12-25')).toBeInTheDocument();
  });

  it('the Add company-holiday button stays disabled until date and name are both valid', async () => {
    render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
    const addButtons = screen.getAllByRole('button', { name: /^add$/i });
    const addHoliday = addButtons[0]!;
    expect(addHoliday).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText('2026-12-25'), '2026-12-25');
    expect(addHoliday).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText('Christmas closure'), 'Office closed');
    expect(addHoliday).toBeEnabled();
  });

  it('adds a company holiday in the "date|name" wire format and clears the add row', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TimeOffEditor data={EMPTY} onSave={onSave} />);
    await userEvent.type(screen.getByPlaceholderText('2026-12-25'), '2026-12-25');
    await userEvent.type(screen.getByPlaceholderText('Christmas closure'), 'Office closed');
    await userEvent.click(screen.getAllByRole('button', { name: /^add$/i })[0]!);

    expect(screen.getByText('Office closed')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('2026-12-25')).toHaveValue('');

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ companyHolidays: ['2026-12-25|Office closed'] }),
    );
  });

  it('removes a company holiday by index', async () => {
    render(
      <TimeOffEditor
        data={{ ...EMPTY, companyHolidays: ['2026-12-25|Christmas closure'] }}
        onSave={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /remove/i }));
    expect(screen.queryByText('Christmas closure')).not.toBeInTheDocument();
    expect(screen.getByText('No company holidays added yet.')).toBeInTheDocument();
  });

  it('adds special hours in the "date|hours" wire format', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TimeOffEditor data={EMPTY} onSave={onSave} />);
    await userEvent.type(screen.getByPlaceholderText('2026-12-24'), '2026-12-24');
    await userEvent.type(screen.getByPlaceholderText('08:00-12:00'), '08:00-12:00');
    await userEvent.click(screen.getAllByRole('button', { name: /^add$/i })[1]!);

    expect(screen.getByText('08:00-12:00')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ specialHours: ['2026-12-24|08:00-12:00'] }),
    );
  });

  it('rejects a pipe character in the holiday name (keeps the wire format parseable)', async () => {
    render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText('2026-12-25'), '2026-12-25');
    await userEvent.type(screen.getByPlaceholderText('Christmas closure'), 'Bad|Name');
    expect(screen.getAllByRole('button', { name: /^add$/i })[0]).toBeDisabled();
  });

  it('Cancel reverts every unsaved change', async () => {
    render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Juneteenth observed' }));
    await userEvent.type(screen.getByPlaceholderText('2026-12-25'), '2026-12-25');
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.getByRole('switch', { name: 'Toggle Juneteenth observed' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('shows a fail-loud error and keeps Save enabled when the write rejects', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('offline'));
    render(<TimeOffEditor data={EMPTY} onSave={onSave} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Juneteenth observed' }));
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/offline/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();
  });
});
