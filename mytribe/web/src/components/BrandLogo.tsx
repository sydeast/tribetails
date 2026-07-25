import { useState } from 'react';

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
 * This is the first image in the portal with an `onError` handler at all. Every
 * other `<img>` (Kin.tsx, TribeHub.tsx, KinDetail.tsx, KinTales.tsx,
 * SignedImageUpload.tsx) only null-checks the URL BEFORE render, which does
 * nothing for a URL that is present but dead. Those are out of scope here, but
 * this is the pattern they want.
 */
export function BrandLogo(props: { logoUrl?: string | undefined; businessName?: string | undefined }) {
  const url = (props.logoUrl ?? '').trim();
  // Keyed on the url: replacing the logo must clear a previous failure, or a
  // fixed logo would stay invisible until a full reload.
  const [failed, setFailed] = useState(false);
  const [failedUrl, setFailedUrl] = useState('');

  if (url === '') return null;
  if (failed && failedUrl === url) return null;

  const name = (props.businessName ?? '').trim();

  return (
    <img
      className="brandlogo"
      src={url}
      // The wordmark beside this already names the product. This image carries
      // the OPERATING BUSINESS's identity, which appears nowhere else in the
      // header, so it gets the business name as its text equivalent rather than
      // being marked decorative.
      alt={name === '' ? 'Business logo' : name}
      onError={() => {
        setFailed(true);
        setFailedUrl(url);
      }}
    />
  );
}
