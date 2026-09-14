// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmergencyContactsEditor } from './EmergencyContactsEditor';
import type { EmergencyContactDraft } from '../api/emergencyContacts';

function Harness({ initial, spy }: { initial: EmergencyContactDraft[]; spy: (d: EmergencyContactDraft[]) => void }) {
  const [value, setValue] = useState(initial);
  return <EmergencyContactsEditor idPrefix="t" value={value} onChange={(d) => { setValue(d); spy(d); }} />;
}

describe('EmergencyContactsEditor', () => {
  it('edits slot one, adds a second, moves it first, and clears a relationship', async () => {
    const spy = vi.fn();
    render(<Harness initial={[{ name: 'Rae', phone: '8055550199', relationship: 'Sister' }]} spy={spy} />);

    expect(screen.queryByRole('button', { name: /remove emergency contact 1/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add a second Emergency Contact' }));
    await userEvent.type(screen.getByLabelText('Name', { selector: '#t-ec-1-name' }), 'Lee');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#t-ec-1-phone' }), '8055550177');
    expect(screen.queryByRole('button', { name: 'Add a second Emergency Contact' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Call Lee first' }));
    expect((screen.getByLabelText('Name', { selector: '#t-ec-0-name' }) as HTMLInputElement).value).toBe('Lee');

    await userEvent.clear(screen.getByLabelText('Relationship (optional)', { selector: '#t-ec-1-relationship' }));
    expect(spy.mock.calls.at(-1)?.[0]).toEqual([
      { name: 'Lee', phone: '8055550177', relationship: '' },
      { name: 'Rae', phone: '8055550199', relationship: '' },
    ]);

    await userEvent.click(screen.getByRole('button', { name: /remove emergency contact 2/i }));
    expect(spy.mock.calls.at(-1)?.[0]).toHaveLength(1);
  });

  it('says who gets called, as a tooltip rather than a subtitle', () => {
    render(<EmergencyContactsEditor idPrefix="t" value={[{ name: '', phone: '', relationship: '' }]} onChange={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Emergency Contact 1' })).toHaveAttribute(
      'title',
      'Called only when no kinfolk can be reached. The first one is called first.',
    );
  });
});
