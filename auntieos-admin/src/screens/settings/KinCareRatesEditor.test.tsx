// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BusinessSettings } from '../../api/settings';
import { KinCareRatesEditor } from './KinCareRatesEditor';

/**
 * `KinCareRatesEditor` only clears "dirty" (and shows "Saved") once its `data`
 * prop reflects the just-written patch -- exactly how `Settings.tsx`'s
 * `persist` feeds a save back to every section. A bare `render` with a static
 * `data` object can never demonstrate that, so this harness plays the
 * parent's role for the one test that needs to see "Saved" appear.
 */
function Harness({
  initial,
  onSave,
}: {
  initial: Record<string, string>;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}) {
  const [serviceRates, setServiceRates] = useState(initial);
  async function persist(patch: Partial<BusinessSettings>) {
    await onSave(patch);
    if (patch.serviceRates) setServiceRates(patch.serviceRates);
  }
  return <KinCareRatesEditor data={{ serviceRates }} onSave={persist} />;
}

describe('KinCareRatesEditor', () => {
  it('shows a hint and no rows when there are no configured rates', () => {
    render(<KinCareRatesEditor data={{ serviceRates: {} }} onSave={vi.fn()} />);
    expect(screen.getByText('No KinCare types yet. Add one below.')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/./)).not.toBeInTheDocument();
  });

  it('renders one row per configured rate', () => {
    render(
      <KinCareRatesEditor data={{ serviceRates: { 'Drop-in visit': '25.00', Overnight: '' } }} onSave={vi.fn()} />,
    );
    expect(screen.getByDisplayValue('Drop-in visit')).toBeInTheDocument();
    expect(screen.getByDisplayValue('25.00')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Overnight')).toBeInTheDocument();
  });

  it('the Add button stays disabled until a new type is entered', async () => {
    render(<KinCareRatesEditor data={{ serviceRates: {} }} onSave={vi.fn()} />);
    const addBtn = screen.getByRole('button', { name: /^add$/i });
    expect(addBtn).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText('e.g. Drop-in visit'), 'Walk');
    expect(addBtn).toBeEnabled();
  });

  it('adds a new type/rate row and Save writes the folded map', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={{}} onSave={onSave} />);
    await userEvent.type(screen.getByPlaceholderText('e.g. Drop-in visit'), 'Walk');
    await userEvent.type(screen.getAllByPlaceholderText('0.00')[0]!, '15.00');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(screen.getByDisplayValue('Walk')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith({ serviceRates: { Walk: '15.00' } });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('editing a row rate marks it dirty and saves the updated value', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<KinCareRatesEditor data={{ serviceRates: { Walk: '10.00' } }} onSave={onSave} />);
    const rateInput = screen.getByDisplayValue('10.00');
    await userEvent.clear(rateInput);
    await userEvent.type(rateInput, '20.00');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith({ serviceRates: { Walk: '20.00' } });
  });

  it('removes a row and Save drops it from the map', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <KinCareRatesEditor data={{ serviceRates: { Walk: '10.00', Overnight: '80.00' } }} onSave={onSave} />,
    );
    await userEvent.click(screen.getAllByRole('button', { name: /remove/i })[0]!);
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith({ serviceRates: { Overnight: '80.00' } });
  });

  it('drops a blank-type row on save (unsaveable, matches the wasm editor)', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<KinCareRatesEditor data={{ serviceRates: { Walk: '10.00' } }} onSave={onSave} />);
    const typeInput = screen.getByDisplayValue('Walk');
    await userEvent.clear(typeInput);
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith({ serviceRates: {} });
  });

  it('Cancel reverts unsaved row edits', async () => {
    render(<KinCareRatesEditor data={{ serviceRates: { Walk: '10.00' } }} onSave={vi.fn()} />);
    const rateInput = screen.getByDisplayValue('10.00');
    await userEvent.clear(rateInput);
    await userEvent.type(rateInput, '99.00');
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.getByDisplayValue('10.00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('shows a fail-loud error and keeps Save enabled when the write rejects', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('permission-denied'));
    render(<KinCareRatesEditor data={{ serviceRates: {} }} onSave={onSave} />);
    await userEvent.type(screen.getByPlaceholderText('e.g. Drop-in visit'), 'Walk');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/permission-denied/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();
  });
});
