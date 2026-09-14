// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmergencyContactsEditor } from './EmergencyContactsEditor';
import type { EmergencyContactDraft } from '../api/emergencyContacts';

function Harness({ initial, spy }: { initial: EmergencyContactDraft[]; spy: (d: EmergencyContactDraft[]) => void }) {
  const [value, setValue] = useState(initial);
  return <EmergencyContactsEditor idPrefix="t" value={value} onChange={(d) => { setValue(d); spy(d); }} />;
}

const slot = (n: number) => screen.getByRole('group', { name: `Emergency Contact ${n}` });

describe('EmergencyContactsEditor', () => {
  it('edits slot one, adds a second, moves it first, and clears a relationship', async () => {
    const spy = vi.fn();
    render(<Harness initial={[{ name: 'Rae', phone: '8055550199', relationship: 'Sister' }]} spy={spy} />);

    // One contact: nothing to reorder or remove.
    expect(within(slot(1)).queryByRole('button', { name: 'Remove' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add a second Emergency Contact' }));
    await userEvent.type(screen.getByLabelText('Name', { selector: '#t-ec-1-name' }), 'Lee');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#t-ec-1-phone' }), '8055550177');
    expect(screen.queryByRole('button', { name: 'Add a second Emergency Contact' })).toBeNull();

    await userEvent.click(within(slot(2)).getByRole('button', { name: 'Call first' }));
    expect((screen.getByLabelText('Name', { selector: '#t-ec-0-name' }) as HTMLInputElement).value).toBe('Lee');

    await userEvent.clear(screen.getByLabelText('Relationship (optional)', { selector: '#t-ec-1-relationship' }));
    expect(spy.mock.calls.at(-1)?.[0]).toEqual([
      { name: 'Lee', phone: '8055550177', relationship: '' },
      { name: 'Rae', phone: '8055550199', relationship: '' },
    ]);

    await userEvent.click(within(slot(2)).getByRole('button', { name: 'Remove' }));
    expect(spy.mock.calls.at(-1)?.[0]).toHaveLength(1);
  });

  // #829 review item 14: Remove on both slots, Call first only where it moves something.
  it('offers Remove on both slots and Call first on the second only', () => {
    render(
      <EmergencyContactsEditor
        idPrefix="t"
        value={[
          { name: 'Rae', phone: '8055550199', relationship: '' },
          { name: 'Lee', phone: '8055550177', relationship: '' },
        ]}
        onChange={vi.fn()}
      />,
    );
    expect(within(slot(1)).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(within(slot(1)).queryByRole('button', { name: 'Call first' })).toBeNull();
    expect(within(slot(2)).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(within(slot(2)).getByRole('button', { name: 'Call first' })).toBeInTheDocument();
  });

  it('caps each input at the server limit', () => {
    render(<EmergencyContactsEditor idPrefix="t" value={[{ name: '', phone: '', relationship: '' }]} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Name', { selector: '#t-ec-0-name' })).toHaveAttribute('maxLength', '80');
    expect(screen.getByLabelText('Phone', { selector: '#t-ec-0-phone' })).toHaveAttribute('maxLength', '32');
    expect(screen.getByLabelText('Relationship (optional)', { selector: '#t-ec-0-relationship' })).toHaveAttribute('maxLength', '40');
  });

  it('carries no hover-only title: the tip sits beside the card title, where a tap opens it', () => {
    render(<EmergencyContactsEditor idPrefix="t" value={[{ name: '', phone: '', relationship: '' }]} onChange={vi.fn()} />);
    expect(slot(1)).not.toHaveAttribute('title');
  });
});
