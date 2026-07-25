// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { BrandLogo } from './BrandLogo';

afterEach(cleanup);

/**
 * The portal header is client-facing. These tests exist for one reason: to pin
 * that NO operator-supplied URL, in any state, can put a broken image in front
 * of a kinfolk. The caller always renders the wordmark, so "render nothing" is
 * a complete and correct fallback here.
 */
describe('BrandLogo: when nothing should render', () => {
  it('renders nothing when no logo is configured', () => {
    const { container } = render(<BrandLogo businessName="Tribe Tails" />);
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders nothing for a blank or whitespace-only url', () => {
    const { container } = render(<BrandLogo logoUrl="   " businessName="Tribe Tails" />);
    expect(container.querySelector('img')).toBeNull();
  });

  it('removes the image when it fails to load, rather than leaving a broken glyph', () => {
    const { container } = render(
      <BrandLogo logoUrl="https://res.cloudinary.com/tribetails/image/upload/gone.png" businessName="Tribe Tails" />,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();

    // The asset 404s, or the kinfolk is offline, or Cloudinary is down.
    fireEvent.error(img!);

    expect(container.querySelector('img')).toBeNull();
  });
});

describe('BrandLogo: when a logo does render', () => {
  const URL = 'https://res.cloudinary.com/tribetails/image/upload/v1/tribetails/business/business_settings/logo.png';

  it('renders the operator logo with the business name as its text equivalent', () => {
    render(<BrandLogo logoUrl={URL} businessName="Tribe Tails Pet Care" />);
    const img = screen.getByAltText('Tribe Tails Pet Care');
    expect(img.getAttribute('src')).toBe(URL);
  });

  it('still has a usable alt when the business has no name set', () => {
    render(<BrandLogo logoUrl={URL} />);
    // Never an empty alt: this image is the only place the operating business
    // is identified in the header, so it is content, not decoration.
    expect(screen.getByAltText('Business logo')).toBeTruthy();
  });

  it('wears the constrained class, so the nav height can never follow the upload', () => {
    const { container } = render(<BrandLogo logoUrl={URL} />);
    expect(container.querySelector('img')?.className).toBe('brandlogo');
  });

  it('retries a NEW url after a previous one failed', () => {
    // Without keying the failure to the url, an operator who uploaded a broken
    // logo and then fixed it would still see nothing until a full reload.
    const { container, rerender } = render(<BrandLogo logoUrl="https://res.cloudinary.com/tribetails/image/upload/bad.png" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();

    rerender(<BrandLogo logoUrl={URL} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(URL);
  });
});
