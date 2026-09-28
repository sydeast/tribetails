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
const NOTICE = 'This household has two Emergency Contacts on file. A household has only one now, so remove one of them.';
describe('EmergencyContactsEditor', () => {
  // Operator ruling 2026-09-27 (Q2): one Emergency Contact per household.
  it('one contact: edits it and clears a relationship, with no add, remove or notice', async () => {
    const spy = vi.fn();
    render(<Harness initial={[{ name: 'Rae', phone: '8055550199', relationship: 'Sister' }]} spy={spy} />);
    expect(within(slot(1)).queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.queryByRole('button', { name: /add/i })).toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
    await userEvent.clear(screen.getByLabelText('Relationship (optional)', { selector: '#t-ec-0-relationship' }));
    expect(spy.mock.calls.at(-1)?.[0]).toEqual([{ name: 'Rae', phone: '8055550199', relationship: '' }]);
  });
  it('two on file: both show under the notice with Remove on each, no Call first, and removing one clears the notice', async () => {
    const spy = vi.fn();
    render(
      <Harness
        initial={[
          { name: 'Rae', phone: '8055550199', relationship: '' },
          { name: 'Lee', phone: '8055550177', relationship: '' },
        ]}
        spy={spy}
      />,
    );
    expect(screen.getByRole('note')).toHaveTextContent(NOTICE);
    expect(within(slot(1)).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(within(slot(2)).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Call first' })).toBeNull();
    expect(screen.queryByRole('button', { name: /add/i })).toBeNull();
    await userEvent.click(within(slot(1)).getByRole('button', { name: 'Remove' }));
    expect(spy.mock.calls.at(-1)?.[0]).toEqual([{ name: 'Lee', phone: '8055550177', relationship: '' }]);
    expect(screen.queryByRole('note')).toBeNull();
    expect(within(slot(1)).queryByRole('button', { name: 'Remove' })).toBeNull();
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
