import { FallbackImage } from './FallbackImage';

/**
 * The operator's logo, in the portal header, beside the MyTribe wordmark.
 *
 * THE WORDMARK IS ALWAYS RENDERED BY THE CALLER, and that is what makes this
 * component safe on a client-facing surface. This is purely additive chrome: if
 * there is no logo, if the URL is broken, if the asset 404s, if the kinfolk is
 * offline, the header still reads "MyTribe" exactly as it did before any of
 * this existed. There is no state in which a kinfolk sees a gap, a
 * broken-image glyph, or a layout that collapsed around a missing asset.
 *
 * That matters more here than in the admin. The admin is one operator who can
 * be told something went wrong; the portal is every client, and a broken image
 * in the header reads as "this company's website is broken".
 *
 * This was the first image in the portal with an `onError` handler at all,
 * before FallbackImage generalized the pattern (issue #397, item S9) and
 * every other portal `<img>` — Kin.tsx, Gallery.tsx, Account.tsx, TribeHub.tsx,
 * KinDetail.tsx, KinTales.tsx, SignedImageUpload.tsx — started using it too.
 * This one's fallback is simply nothing: no other surface gets to make that
 * choice, because every other surface IS the content, while this one is
 * chrome next to a wordmark that already carries the product's name.
 */
export function BrandLogo(props: { logoUrl?: string | undefined; businessName?: string | undefined }) {
  const name = (props.businessName ?? '').trim();

  return (
    <FallbackImage
      className="brandlogo"
      src={props.logoUrl}
      // The wordmark beside this already names the product. This image carries
      // the OPERATING BUSINESS's identity, which appears nowhere else in the
      // header, so it gets the business name as its text equivalent rather than
      // being marked decorative.
      alt={name === '' ? 'Business logo' : name}
      fallback={null}
    />
  );
}
