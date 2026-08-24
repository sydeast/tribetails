// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { FallbackImage } from './FallbackImage';

afterEach(cleanup);

const URL = 'https://res.cloudinary.com/tribetails/image/upload/v1/kin/photo.jpg';

/**
 * jsdom never attempts a real network fetch for an `<img src>`, so it can
 * never fire a genuine `error` event the way a browser does when an asset
 * 404s. `fireEvent.error(img)` does not fake that network behavior — it
 * dispatches a real DOM `error` Event at the real `<img>` node, which React's
 * synthetic event system delivers to the exact `onError` handler these
 * components register. That is the same technique BrandLogo.test.tsx already
 * relies on to prove its handler runs; every test below that calls
 * `fireEvent.error` is exercising the real `onError` prop, not a stand-in.
 */
describe('FallbackImage', () => {
  it('renders the fallback, not an <img>, when there is no src', () => {
    const { container, getByText } = render(<FallbackImage src={undefined} alt="" fallback={<span>NOPHOTO</span>} />);
    expect(container.querySelector('img')).toBeNull();
    expect(getByText('NOPHOTO')).toBeTruthy();
  });

  it('renders the fallback for a blank/whitespace-only src', () => {
    const { container } = render(<FallbackImage src="   " alt="" fallback={<span>NOPHOTO</span>} />);
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders a real <img> for a present src', () => {
    const { container } = render(<FallbackImage src={URL} alt="A kin" fallback={<span>NOPHOTO</span>} />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe(URL);
    expect(img?.getAttribute('alt')).toBe('A kin');
  });

  it('swaps to the fallback once the <img> fires a load error, with no <img> left in the DOM', () => {
    const { container, getByText } = render(<FallbackImage src={URL} alt="A kin" fallback={<span>NOPHOTO</span>} />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();

    fireEvent.error(img!);

    expect(container.querySelector('img')).toBeNull();
    expect(getByText('NOPHOTO')).toBeTruthy();
  });

  it('cannot loop: the fallback is markup, not another <img src>, so nothing is left that can fire a second onError', () => {
    const { container } = render(<FallbackImage src={URL} alt="A kin" fallback={<span>NOPHOTO</span>} />);
    fireEvent.error(container.querySelector('img')!);

    // The failure state renders the fallback prop verbatim -- there is no
    // <img> anywhere in the tree to dispatch a second error at.
    expect(container.querySelectorAll('img').length).toBe(0);
  });

  it('recovers once a NEW src is passed after a previous one failed', () => {
    const { container, rerender } = render(
      <FallbackImage src="https://res.cloudinary.com/tribetails/image/upload/gone.jpg" alt="A kin" fallback={<span>NOPHOTO</span>} />,
    );
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();

    rerender(<FallbackImage src={URL} alt="A kin" fallback={<span>NOPHOTO</span>} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(URL);
  });

  it('does NOT recover on a re-render that repeats the same failed src', () => {
    const { container, rerender } = render(<FallbackImage src={URL} alt="A kin" fallback={<span>NOPHOTO</span>} />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();

    rerender(<FallbackImage src={URL} alt="A kin" fallback={<span>NOPHOTO</span>} />);
    expect(container.querySelector('img')).toBeNull();
  });
});
