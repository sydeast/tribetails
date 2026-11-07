// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RichText } from './RichText';
describe('RichText', () => {
  it('renders formatting, not the tags as text', () => {
    const { container } = render(
      <RichText body="<p>Hi Auntie, <strong>please give Sandbox Dog</strong> an extra treat!</p>" />,
    );
    expect(container.textContent).toBe('Hi Auntie, please give Sandbox Dog an extra treat!');
    expect(container.querySelector('strong')?.textContent).toBe('please give Sandbox Dog');
    expect(container.textContent).not.toContain('<p>');
  });
  it('never creates a script, img or handler from a hostile body', () => {
    const { container } = render(
      <RichText body={'<p onclick="x()">a</p><script>window.__pwn=1</script><img src=x onerror="window.__pwn=1"><a href="javascript:window.__pwn=1">l</a>'} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onclick]')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect((window as unknown as { __pwn?: number }).__pwn).toBeUndefined();
  });
  it('opens links safely', () => {
    render(<RichText body='<a href="https://example.com">site</a>' />);
    const a = screen.getByRole('link', { name: 'site' });
    expect(a).toHaveAttribute('href', 'https://example.com');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    expect(a).toHaveAttribute('target', '_blank');
  });
  it('keeps line breaks of a plain reply', () => {
    const { container } = render(<RichText body={'line one\nline two'} />);
    expect(container.firstElementChild).toHaveStyle({ whiteSpace: 'pre-wrap' });
    expect(container.textContent).toBe('line one\nline two');
  });
});
