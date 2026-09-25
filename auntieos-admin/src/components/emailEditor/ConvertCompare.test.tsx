// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { previewEmailTemplate } = vi.hoisted(() => ({ previewEmailTemplate: vi.fn() }));
vi.mock('../../api/templatesWrite', () => ({ previewEmailTemplate }));

import { ConvertCompare } from './ConvertCompare';

const OLD = { subject: 'Old subject', body: 'Hi {{displayName}}', html: '<p>Old <b>html</b></p>' };
const CONVERTED = { subject: 'Old subject', headline: 'Reset', content: '<p>Hi {{displayName}}</p>', warnings: [] };

beforeEach(() => {
  previewEmailTemplate.mockReset();
});

describe('ConvertCompare', () => {
  it('shows the old email and the server preview of the converted one side by side', async () => {
    previewEmailTemplate.mockResolvedValue({ subject: 'Old subject', html: '<html>new</html>', text: 't', issues: [] });
    render(<ConvertCompare old={OLD} converted={CONVERTED} catalogKey="auth.password.reset" onUse={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByTitle('The old email')).toHaveAttribute('srcdoc', OLD.html);
    await vi.waitFor(
      () =>
        expect(previewEmailTemplate).toHaveBeenCalledWith({
          subject: CONVERTED.subject,
          headline: CONVERTED.headline,
          content: CONVERTED.content,
          catalogKey: 'auth.password.reset',
        }),
      { timeout: 2000 },
    );
    expect(await screen.findByTitle('The email as it will be sent', {}, { timeout: 2000 })).toHaveAttribute(
      'srcdoc',
      '<html>new</html>',
    );
    expect(screen.getByRole('region', { name: 'Converted email' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Old email' })).toBeInTheDocument();
  });

  it('marks the converted side busy while its preview is on the way', () => {
    previewEmailTemplate.mockReturnValue(new Promise(() => {}));
    render(<ConvertCompare old={OLD} converted={CONVERTED} catalogKey={null} onUse={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Converted email' })).toHaveAttribute('aria-busy', 'true');
  });

  it('shows an old template with no HTML as its plain text, escaped', () => {
    previewEmailTemplate.mockResolvedValue({ subject: 's', html: '', text: '', issues: [] });
    render(
      <ConvertCompare
        old={{ subject: 's', body: 'a < b', html: null }}
        converted={CONVERTED}
        catalogKey={null}
        onUse={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByTitle('The old email').getAttribute('srcdoc')).toContain('a &lt; b');
  });

  it('lists what the conversion could not keep, and still offers the converted version', async () => {
    previewEmailTemplate.mockResolvedValue({ subject: 's', html: '', text: '', issues: [] });
    const onUse = vi.fn();
    render(
      <ConvertCompare
        old={OLD}
        converted={{ ...CONVERTED, warnings: ['Removed an image that is not from your Cloudinary library.'] }}
        catalogKey={null}
        onUse={onUse}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText('Removed an image that is not from your Cloudinary library.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Use the converted version' }));
    expect(onUse).toHaveBeenCalledTimes(1);
  });

  it('shows no warnings block when there are none', () => {
    previewEmailTemplate.mockResolvedValue({ subject: 's', html: '', text: '', issues: [] });
    render(<ConvertCompare old={OLD} converted={CONVERTED} catalogKey={null} onUse={vi.fn()} onBack={vi.fn()} />);
    expect(screen.queryByText('Not carried over')).toBeNull();
  });

  it('the two buttons call their handlers', async () => {
    previewEmailTemplate.mockResolvedValue({ subject: 's', html: '', text: '', issues: [] });
    const onUse = vi.fn();
    const onBack = vi.fn();
    render(<ConvertCompare old={OLD} converted={CONVERTED} catalogKey={null} onUse={onUse} onBack={onBack} />);
    await userEvent.click(screen.getByRole('button', { name: 'Use the converted version' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep the old format' }));
    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
