/**
 * The Call and Text pair for a phone number: two ghost buttons on `tel:` and
 * `sms:` links. Lifted out of Tribe Profile (the auntie contact and the vet
 * clinic both drew this exact pair) so the About screen (#1411) reaches the
 * business number the same way. Renders nothing for a blank number.
 */
export function PhoneActions(props: { phone: string | null | undefined }) {
  const phone = (props.phone ?? '').trim();
  if (phone === '') return null;
  return (
    <>
      <a className="btn ghost" href={`tel:${phone}`} style={{ padding: '9px 14px', fontSize: 13 }}>
        {'\u{1F4DE}'} Call
      </a>
      <a className="btn ghost" href={`sms:${phone}`} style={{ padding: '9px 14px', fontSize: 13 }}>
        {'\u{1F4AC}'} Text
      </a>
    </>
  );
}
