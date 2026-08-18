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
  return <KinCareRatesEditor data={{ serviceRates, serviceDurations: {} }} onSave={persist} />;
}

describe('KinCareRatesEditor', () => {
  it('shows a hint and no rows when there are no configured rates', () => {
    render(<KinCareRatesEditor data={{ serviceRates: {}, serviceDurations: {} }} onSave={vi.fn()} />);
    expect(screen.getByText('No KinCare types yet. Add one below.')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/./)).not.toBeInTheDocument();
  });

  it('renders one row per configured rate', () => {
    render(
      <KinCareRatesEditor data={{ serviceRates: { 'Drop-in visit': '25.00', Overnight: '' }, serviceDurations: {} }} onSave={vi.fn()} />,
    );
    expect(screen.getByDisplayValue('Drop-in visit')).toBeInTheDocument();
    expect(screen.getByDisplayValue('25.00')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Overnight')).toBeInTheDocument();
  });

  it('the Add button stays disabled until a new type is entered', async () => {
    render(<KinCareRatesEditor data={{ serviceRates: {}, serviceDurations: {} }} onSave={vi.fn()} />);
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
    expect(onSave).toHaveBeenCalledWith({ serviceRates: { Walk: '15.00' }, serviceDurations: {} });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('editing a row rate marks it dirty and saves the updated value', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<KinCareRatesEditor data={{ serviceRates: { Walk: '10.00' }, serviceDurations: {} }} onSave={onSave} />);
    const rateInput = screen.getByDisplayValue('10.00');
    await userEvent.clear(rateInput);
    await userEvent.type(rateInput, '20.00');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith({ serviceRates: { Walk: '20.00' }, serviceDurations: {} });
  });

  it('removes a row and Save drops it from the map', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <KinCareRatesEditor data={{ serviceRates: { Walk: '10.00', Overnight: '80.00' }, serviceDurations: {} }} onSave={onSave} />,
    );
    await userEvent.click(screen.getAllByRole('button', { name: /remove/i })[0]!);
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith({ serviceRates: { Overnight: '80.00' }, serviceDurations: {} });
  });

  it('drops a blank-type row on save (unsaveable, matches the wasm editor)', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<KinCareRatesEditor data={{ serviceRates: { Walk: '10.00' }, serviceDurations: {} }} onSave={onSave} />);
    const typeInput = screen.getByDisplayValue('Walk');
    await userEvent.clear(typeInput);
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith({ serviceRates: {}, serviceDurations: {} });
  });

  it('Cancel reverts unsaved row edits', async () => {
    render(<KinCareRatesEditor data={{ serviceRates: { Walk: '10.00' }, serviceDurations: {} }} onSave={vi.fn()} />);
    const rateInput = screen.getByDisplayValue('10.00');
    await userEvent.clear(rateInput);
    await userEvent.type(rateInput, '99.00');
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.getByDisplayValue('10.00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  /**
   * MARK 15 OF THE 2026-08-17 WALK. The operator was offered "rename Type to
   * Service Duration" or "give kincare a third attribute: name/title,
   * duration, and price", and picked the third attribute with three columns.
   * These pin the parts of that which are easy to get subtly wrong.
   */
  describe('duration, the third column', () => {
    it('writes the typed duration to serviceDurations, keyed by the same name', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(
        <KinCareRatesEditor data={{ serviceRates: { Walk: '15.00' }, serviceDurations: {} }} onSave={onSave} />,
      );
      await userEvent.type(screen.getByLabelText('Duration (min)'), '45');
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
      expect(onSave).toHaveBeenCalledWith({
        serviceRates: { Walk: '15.00' },
        serviceDurations: { Walk: '45' },
      });
    });
    it('renders a stored duration in its own field, not folded into the name', () => {
      render(
        <KinCareRatesEditor
          data={{ serviceRates: { Walk: '15.00' }, serviceDurations: { Walk: '45' } }}
          onSave={vi.fn()}
        />,
      );
      expect(screen.getByDisplayValue('Walk')).toBeInTheDocument();
      expect(screen.getByDisplayValue('45')).toBeInTheDocument();
    });
    it('SHOWS what the name implies as a placeholder, and does not save it as a value', async () => {
      // The app has always read "30Minute" as 30 minutes. Showing that is
      // honest; writing it into the document uninvited would turn the parse
      // into a stored fact the operator never stated.
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(
        <KinCareRatesEditor
          data={{ serviceRates: { '30Minute': '15.00', Consultation: '0' }, serviceDurations: {} }}
          onSave={onSave}
        />,
      );
      expect(screen.getByPlaceholderText('30 (from the name)')).toBeInTheDocument();
      await userEvent.type(screen.getByDisplayValue('0'), '5');
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
      const [patch] = onSave.mock.calls[0] as [{ serviceDurations: Record<string, string> }];
      expect(patch.serviceDurations).toEqual({});
    });
    it('keeps serviceDurations SPARSE: a cleared duration drops its key entirely', async () => {
      // An empty string here would read as "the operator stated a length" and
      // would stop the name-parse fallback from ever running for this type.
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(
        <KinCareRatesEditor
          data={{ serviceRates: { Walk: '15.00' }, serviceDurations: { Walk: '45' } }}
          onSave={onSave}
        />,
      );
      await userEvent.clear(screen.getByDisplayValue('45'));
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
      expect(onSave).toHaveBeenCalledWith({ serviceRates: { Walk: '15.00' }, serviceDurations: {} });
    });
    it('a duration-only edit is dirty, so the Save button is reachable', async () => {
      render(
        <KinCareRatesEditor data={{ serviceRates: { Walk: '15.00' }, serviceDurations: {} }} onSave={vi.fn()} />,
      );
      expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
      await userEvent.type(screen.getByLabelText('Duration (min)'), '45');
      expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();
    });
  });
  describe('the sorter', () => {
    const threeTypes = {
      serviceRates: { Overnight: '80.00', '30Minute': '15.00', Consultation: '' },
      serviceDurations: { Overnight: '720' },
    };
    /** Row order as the name inputs read it, top to bottom. */
    function nameOrder(): string[] {
      return screen
        .getAllByRole('textbox')
        .map((el) => (el as HTMLInputElement).value)
        .filter((v) => v === 'Overnight' || v === '30Minute' || v === 'Consultation');
    }
    it('offers no sorter until there is more than one row to sort', () => {
      render(<KinCareRatesEditor data={{ serviceRates: { Walk: '1' }, serviceDurations: {} }} onSave={vi.fn()} />);
      expect(screen.queryByRole('group', { name: /sort kincare types/i })).toBeNull();
    });
    it('sorts by name', async () => {
      render(<KinCareRatesEditor data={threeTypes} onSave={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: 'Name' }));
      expect(nameOrder()).toEqual(['30Minute', 'Consultation', 'Overnight']);
    });
    it('sorts by rate, with an unset price last rather than free', async () => {
      render(<KinCareRatesEditor data={threeTypes} onSave={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: 'Rate' }));
      expect(nameOrder()).toEqual(['30Minute', 'Overnight', 'Consultation']);
    });
    it('sorts by duration, preferring the stored minutes over the name', async () => {
      // Overnight states no length in its name and is 720 minutes in the map.
      // Consultation states none anywhere, so it sorts last.
      render(<KinCareRatesEditor data={threeTypes} onSave={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: 'Duration' }));
      expect(nameOrder()).toEqual(['30Minute', 'Overnight', 'Consultation']);
    });
    it('is a VIEW: sorting reorders nothing that gets saved, and edits still hit the right row', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<KinCareRatesEditor data={threeTypes} onSave={onSave} />);
      await userEvent.click(screen.getByRole('button', { name: 'Name' }));
      // Third row on screen under this sort is Overnight. Editing it must
      // change Overnight and not whatever is third in the stored map.
      const overnightRate = screen.getByDisplayValue('80.00');
      await userEvent.clear(overnightRate);
      await userEvent.type(overnightRate, '90.00');
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
      expect(onSave).toHaveBeenCalledWith({
        serviceRates: { Overnight: '90.00', '30Minute': '15.00', Consultation: '' },
        serviceDurations: { Overnight: '720' },
      });
    });
  });
  it('shows a fail-loud error and keeps Save enabled when the write rejects', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('permission-denied'));
    render(<KinCareRatesEditor data={{ serviceRates: {}, serviceDurations: {} }} onSave={onSave} />);
    await userEvent.type(screen.getByPlaceholderText('e.g. Drop-in visit'), 'Walk');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/permission-denied/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();
  });
});
