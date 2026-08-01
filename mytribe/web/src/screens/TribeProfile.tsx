import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getBusinessContact } from '../api/portal';
import { SecretField } from '../components/SecretField';
import {
  addSecondaryContact,
  clinicAlreadyOnList,
  getFormSchema,
  getMyTribeProfile,
  getVetClinics,
  HOME_RESERVED_KEYS,
  isDisplayableField,
  listMembers,
  mapboxRetrieve,
  mapboxSearch,
  memberStatusLabel,
  mergeReservedFields,
  newMapboxSessionToken,
  PROFILE_RESERVED_KEYS,
  resolveMapboxAddress,
  saveHomeAccess,
  saveTribeProfile,
  submitVetClinic,
  updateSecondaryPermissions,
  type CustomFieldDto,
  type FormFieldDto,
  type FormSchemaDto,
  type MapboxSuggestionDto,
  type MemberDto,
  type VetClinicDto,
} from '../api/tribeApi';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { PortalNav } from '../components/PortalNav';
import { LaunchError } from './LaunchError';

const ADDRESS_DEBOUNCE_MS = 250;

/**
 * Reads one of the three reserved home-access fields when a homeAccess schema
 * is driving the form. Holding the key means the schema owns the field, so an
 * emptied input has to save as null.
 *
 * This used to read `(values[key] ?? '').trim() || staticValue.trim() || null`.
 * Emptying the schema input made the first operand falsy and the fallback
 * re-sent the value loaded from the server, while the screen still printed
 * "Saved.", so a kinfolk could not remove a compromised gate code, key
 * location, or Wi-Fi password. The static (no-schema) path always cleared
 * correctly; the behavior forked on whether an admin had authored a schema.
 * The static value stays as the fallback for the case where the schema loaded
 * before the profile did and the value map is not seeded yet.
 */
function schemaTextOrNull(values: Record<string, string>, key: string, staticValue: string): string | null {
  const fromSchema = values[key];
  if (fromSchema !== undefined) return fromSchema.trim() || null;
  return staticValue.trim() || null;
}

/**
 * Tribe Profile editor: the full edit surface for household settings, ported
 * from ui-ideas/mytribe-tribe-2026-05-31.html (the mockup's entire body is
 * this screen — Family / Home Information / Vet Clinic cards + save bar).
 * Structurally follows TribeScreen.kt (src/commonMain/kotlin/com/kinfolk/
 * portal/screens/tribe/TribeScreen.kt), which is the authoritative behavior
 * spec where the 2026-05-31 mockup is now stale:
 *
 *  - Custom profile/home fields are admin-defined via getFormSchema
 *    ('tribeProfile' / 'homeAccess') when a schema exists; a kinfolk cannot
 *    freely add/remove Label/Value rows the way the older mockup showed
 *    (`+ Add Profile Field` / `+ Add Home Field` are NOT implemented for
 *    that reason — Compose dropped them for the same schema-gated model).
 *    Any already-saved custom fields still display, read-only, so no data
 *    is hidden. This mirrors TribeScreen.kt's CustomFieldList comment
 *    verbatim: "Read-only: admins define fields in AuntieOS; a kinfolk
 *    cannot add them."
 *  - Household member permissions + a secondary-invite card live on this
 *    screen too (HouseholdMembersCard / SecondaryInviteCard in TribeScreen.kt),
 *    even though the mockup doesn't show them — there's no separate mockup
 *    for either, so the layout below follows the same glass-card idiom.
 *  - Emergency Contact + Vet Clinic after-hours fields are additions from
 *    TribeScreen.kt with no mockup coverage either; stored in the same
 *    customFields stores under stable keys (no backend change needed).
 */
export function TribeProfile() {
  const queryClient = useQueryClient();
  const kinfolkId = getActiveKinfolkId();

  const profile = useQuery({ queryKey: ['tribeProfile', kinfolkId], queryFn: () => getMyTribeProfile(kinfolkId) });
  const profileSchemaQ = useQuery({
    queryKey: ['formSchema', 'tribeProfile'],
    queryFn: () => getFormSchema('tribeProfile'),
    retry: false,
  });
  const homeSchemaQ = useQuery({ queryKey: ['formSchema', 'homeAccess'], queryFn: () => getFormSchema('homeAccess'), retry: false });
  const vetClinicsQ = useQuery({ queryKey: ['vetClinics'], queryFn: () => getVetClinics() });
  const contactQ = useQuery({ queryKey: ['businessContact'], queryFn: () => getBusinessContact() });
  const membersQ = useQuery({ queryKey: ['members', kinfolkId], queryFn: () => listMembers(kinfolkId) });

  // ---- Family ----
  const [displayName, setDisplayName] = useState('');
  const [profileValues, setProfileValues] = useState<Record<string, string>>({});

  // ---- Home Information ----
  const [gateCode, setGateCode] = useState('');
  const [keyLocation, setKeyLocation] = useState('');
  const [wifi, setWifi] = useState('');
  const [homeValues, setHomeValues] = useState<Record<string, string>>({});

  // ---- Vet Clinic ----
  const [vetQuery, setVetQuery] = useState('');
  const [vetName, setVetName] = useState('');
  const [vetPhone, setVetPhone] = useState('');
  const [vetAddress, setVetAddress] = useState('');
  const [afterHoursVetName, setAfterHoursVetName] = useState('');
  const [afterHoursVetPhone, setAfterHoursVetPhone] = useState('');
  const [addressSuggestions, setAddressSuggestions] = useState<MapboxSuggestionDto[]>([]);
  const [addressError, setAddressError] = useState<string | null>(null);
  const sessionTokenRef = useRef(newMapboxSessionToken());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [submittingClinic, setSubmittingClinic] = useState(false);
  const [submitClinicMsg, setSubmitClinicMsg] = useState<string | null>(null);

  // ---- Emergency Contact ----
  const [emergencyName, setEmergencyName] = useState('');
  const [emergencyPhone, setEmergencyPhone] = useState('');
  const [emergencyRelation, setEmergencyRelation] = useState('');

  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Seed local edit state once the profile load resolves.
  useEffect(() => {
    if (!profile.data) return;
    const { profile: p, homeAccess } = profile.data;
    setDisplayName(p.displayName);
    setGateCode(homeAccess.gateCode ?? '');
    setKeyLocation(homeAccess.keyLocation ?? '');
    setWifi(homeAccess.wifiPassword ?? '');

    const byKey = (fields: CustomFieldDto[]) => Object.fromEntries(fields.map((f) => [f.key, f.value]));
    const pByKey = byKey(p.customFields);
    const aByKey = byKey(homeAccess.customFields);
    setVetName(pByKey['vetClinicName'] ?? '');
    setVetPhone(pByKey['vetClinicPhone'] ?? '');
    setVetAddress(pByKey['vetClinicAddress'] ?? '');
    setEmergencyName(pByKey['emergencyContactName'] ?? '');
    setEmergencyPhone(pByKey['emergencyContactPhone'] ?? '');
    setEmergencyRelation(pByKey['emergencyContactRelation'] ?? '');
    setAfterHoursVetName(aByKey['afterHoursVetName'] ?? '');
    setAfterHoursVetPhone(aByKey['afterHoursVetPhone'] ?? '');
  }, [profile.data]);

  // Seed schema value maps once a schema loads (best-effort; static fields stay authoritative otherwise).
  useEffect(() => {
    if (!profileSchemaQ.data || !profile.data) return;
    const seeded: Record<string, string> = { displayName: profile.data.profile.displayName };
    for (const f of profile.data.profile.customFields) seeded[f.key] = f.value;
    setProfileValues(seeded);
  }, [profileSchemaQ.data, profile.data]);

  useEffect(() => {
    if (!homeSchemaQ.data || !profile.data) return;
    const { homeAccess } = profile.data;
    const seeded: Record<string, string> = {
      gateCode: homeAccess.gateCode ?? '',
      keyLocation: homeAccess.keyLocation ?? '',
      wifiPassword: homeAccess.wifiPassword ?? '',
    };
    for (const f of homeAccess.customFields) seeded[f.key] = f.value;
    setHomeValues(seeded);
  }, [homeSchemaQ.data, profile.data]);

  const { signOut, signingOut } = useSignOut();

  if (profile.isError) {
    return <LaunchError onRetry={() => void profile.refetch()} retrying={profile.isRefetching} onSignOut={signOut} signingOut={signingOut} />;
  }

  const profileSchema = profileSchemaQ.data;
  const homeSchema = homeSchemaQ.data;

  // The name that will actually be sent. In schema mode the input writes
  // profileValues, so reading `displayName` here would check the value loaded
  // from the server rather than the one on screen. handleSave sends this same
  // value, so the Save guard and the payload cannot disagree.
  const effectiveDisplayName = profileSchema && profileValues['displayName'] !== undefined
    ? profileValues['displayName']
    : displayName;
  const clinics = vetClinicsQ.data?.clinics ?? [];
  const contact = contactQ.data;
  const members = membersQ.data?.members.filter((m) => m.role !== 'PRIMARY') ?? [];

  const visibleProfileFields = (profile.data?.profile.customFields ?? [])
    .filter((f) => !PROFILE_RESERVED_KEYS.includes(f.key as (typeof PROFILE_RESERVED_KEYS)[number]))
    .filter(isDisplayableField);
  const visibleHomeFields = (profile.data?.homeAccess.customFields ?? [])
    .filter((f) => !HOME_RESERVED_KEYS.includes(f.key as (typeof HOME_RESERVED_KEYS)[number]))
    .filter(isDisplayableField);

  const vetMatches = vetQuery.trim().length > 0 ? clinics.filter((c) => c.name.toLowerCase().includes(vetQuery.trim().toLowerCase())).slice(0, 8) : [];

  function pickClinic(c: VetClinicDto) {
    setVetName(c.name);
    setVetPhone(c.phone);
    setVetAddress(c.address);
    setVetQuery('');
  }

  function onAddressChange(v: string) {
    setVetAddress(v);
    setAddressError(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (v.trim().length < 3) {
      setAddressSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(() => {
      mapboxSearch(v, sessionTokenRef.current)
        .then((r) => setAddressSuggestions(r.suggestions))
        .catch((err: unknown) => {
          setAddressSuggestions([]);
          setAddressError(err instanceof Error ? err.message : 'Address lookup failed');
        });
    }, ADDRESS_DEBOUNCE_MS);
  }

  function pickAddressSuggestion(s: MapboxSuggestionDto) {
    mapboxRetrieve(s.mapbox_id, sessionTokenRef.current)
      .then((r) => {
        setVetAddress(resolveMapboxAddress(r.feature) || s.full_address || s.name);
        setAddressSuggestions([]);
        sessionTokenRef.current = newMapboxSessionToken();
      })
      .catch((err: unknown) => setAddressError(err instanceof Error ? err.message : 'Retrieve failed'));
  }

  function submitClinicToSharedList() {
    if (submittingClinic) return;
    setSubmittingClinic(true);
    setSubmitClinicMsg(null);
    submitVetClinic({ name: vetName.trim(), phone: vetPhone.trim(), address: vetAddress.trim() })
      .then((r) => {
        setSubmitClinicMsg(
          !r.created && !r.pending ? 'That clinic is already on the shared list.' : 'Sent to Auntie for approval. It joins the shared list once approved.',
        );
        void queryClient.invalidateQueries({ queryKey: ['vetClinics'] });
      })
      .catch((err: unknown) => setSubmitClinicMsg(`Couldn't submit: ${err instanceof Error ? err.message : 'unknown error'}`))
      .finally(() => setSubmittingClinic(false));
  }

  async function handleSave() {
    setSaving(true);
    setStatus(null);
    try {
      const vetFields: CustomFieldDto[] = [];
      if (vetName.trim()) vetFields.push({ key: 'vetClinicName', label: 'Vet Clinic', value: vetName.trim() });
      if (vetPhone.trim()) vetFields.push({ key: 'vetClinicPhone', label: 'Vet Clinic Phone', value: vetPhone.trim() });
      if (vetAddress.trim()) vetFields.push({ key: 'vetClinicAddress', label: 'Vet Clinic Address', value: vetAddress.trim() });
      if (emergencyName.trim()) vetFields.push({ key: 'emergencyContactName', label: 'Emergency Contact', value: emergencyName.trim() });
      if (emergencyPhone.trim()) vetFields.push({ key: 'emergencyContactPhone', label: 'Emergency Contact Phone', value: emergencyPhone.trim() });
      if (emergencyRelation.trim())
        vetFields.push({ key: 'emergencyContactRelation', label: 'Emergency Contact Relation', value: emergencyRelation.trim() });

      const baseProfileFields = profile.data?.profile.customFields ?? [];
      const nextDisplayName = effectiveDisplayName.trim();
      let profileCustomFields = mergeReservedFields(baseProfileFields, vetFields, PROFILE_RESERVED_KEYS);
      if (profileSchema) {
        const schemaFields = profileSchema.sections.flatMap((s) => s.fields).filter((f) => f.key !== 'displayName');
        const fromSchema = schemaFields.map((f) => ({ key: f.key, label: f.label, value: profileValues[f.key] ?? '' }));
        profileCustomFields = mergeReservedFields(fromSchema, vetFields, PROFILE_RESERVED_KEYS);
      }
      await saveTribeProfile({
        ...(kinfolkId !== undefined ? { kinfolkId } : {}),
        displayName: nextDisplayName,
        customFields: profileCustomFields,
      });

      const afterHoursFields: CustomFieldDto[] = [];
      if (afterHoursVetName.trim()) afterHoursFields.push({ key: 'afterHoursVetName', label: 'After-hours Clinic', value: afterHoursVetName.trim() });
      if (afterHoursVetPhone.trim()) afterHoursFields.push({ key: 'afterHoursVetPhone', label: 'After-hours Phone', value: afterHoursVetPhone.trim() });

      const baseHomeFields = profile.data?.homeAccess.customFields ?? [];
      let nextGateCode: string | null = gateCode.trim() || null;
      let nextKeyLocation: string | null = keyLocation.trim() || null;
      let nextWifi: string | null = wifi.trim() || null;
      let homeCustomFields = mergeReservedFields(baseHomeFields, afterHoursFields, HOME_RESERVED_KEYS);
      if (homeSchema) {
        nextGateCode = schemaTextOrNull(homeValues, 'gateCode', gateCode);
        nextKeyLocation = schemaTextOrNull(homeValues, 'keyLocation', keyLocation);
        nextWifi = schemaTextOrNull(homeValues, 'wifiPassword', wifi);
        const schemaFields = homeSchema.sections
          .flatMap((s) => s.fields)
          .filter((f) => f.key !== 'gateCode' && f.key !== 'keyLocation' && f.key !== 'wifiPassword');
        const fromSchema = schemaFields.map((f) => ({ key: f.key, label: f.label, value: homeValues[f.key] ?? '' }));
        homeCustomFields = mergeReservedFields(fromSchema, afterHoursFields, HOME_RESERVED_KEYS);
      }
      await saveHomeAccess({
        ...(kinfolkId !== undefined ? { kinfolkId } : {}),
        gateCode: nextGateCode,
        keyLocation: nextKeyLocation,
        wifiPassword: nextWifi,
        customFields: homeCustomFields,
      });

      setStatus('Saved. Auntie will be notified.');
      void queryClient.invalidateQueries({ queryKey: ['tribeProfile', kinfolkId] });
    } catch (err) {
      setStatus(`Save failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PortalNav active="tribe" displayName={displayName} />

      <div className="wrap">
        <header className="hero-greet">
          <div className="kick">Household settings</div>
          <h1>
            Tribe <span>Profile</span>
          </h1>
          <p className="sub" style={{ maxWidth: '64ch', fontSize: 14 }}>
            The details your Aunties rely on when they visit. Keep names, home access, and your vet handy so every drop in goes smoothly.
          </p>
        </header>

        <div className="stack">
          {contact && (contact.phone || contact.email) && (
            <section className="glass card d1">
              <h3 className="title">Contact {contact.name || 'Auntie'}</h3>
              <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                {contact.phone && (
                  <>
                    <a className="btn ghost" href={`tel:${contact.phone}`} style={{ padding: '9px 14px', fontSize: 13 }}>
                      {'\u{1F4DE}'} Call
                    </a>
                    <a className="btn ghost" href={`sms:${contact.phone}`} style={{ padding: '9px 14px', fontSize: 13 }}>
                      {'\u{1F4AC}'} Text
                    </a>
                  </>
                )}
                {contact.email && (
                  <a className="btn ghost" href={`mailto:${contact.email}`} style={{ padding: '9px 14px', fontSize: 13 }}>
                    {'✉'} Email
                  </a>
                )}
              </div>
            </section>
          )}

          {profile.isLoading ? (
            <p className="sub">Loading your Tribe profile…</p>
          ) : (
            <>
              {/* FAMILY CARD */}
              <section className="glass card d1">
                <div className="cardhead">
                  <div className="ic orange">{'\u{1F46A}'}</div>
                  <div className="htxt">
                    <h3 className="title">Family</h3>
                    <p className="sub">How your household shows up across MyTribe.</p>
                  </div>
                </div>

                {profileSchema ? (
                  <SchemaSection schema={profileSchema} values={profileValues} onChange={setProfileValues} />
                ) : (
                  <>
                    <div className="grid2">
                      <div className="field full">
                        <label htmlFor="famname">Family Display Name</label>
                        <input id="famname" className="inp" type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                      </div>
                    </div>
                    {visibleProfileFields.length > 0 && (
                      <>
                        <hr className="divider" />
                        <div className="sectlabel">Profile fields</div>
                        <p className="customfields-note">Set by your Auntie. Ask them to update these.</p>
                        {visibleProfileFields.map((f) => (
                          <div className="customfield-row" key={f.key}>
                            {f.label && <div className="cflabel">{f.label}</div>}
                            <div className="cfvalue">{f.value}</div>
                          </div>
                        ))}
                      </>
                    )}
                  </>
                )}
              </section>

              {/* HOME INFORMATION CARD */}
              <section className="glass card d2">
                <div className="cardhead">
                  <div className="ic teal">{'\u{1F3E0}'}</div>
                  <div className="htxt">
                    <h3 className="title">Home Information</h3>
                    <p className="sub">Shared only with the Aunties booked for your visits.</p>
                  </div>
                </div>

                {homeSchema ? (
                  <SchemaSection schema={homeSchema} values={homeValues} onChange={setHomeValues} />
                ) : (
                  <>
                    <div className="grid2">
                      <div className="field">
                        <SecretField
                          id="gate"
                          className="inp mono"
                          label="Gate / Door Code"
                          value={gateCode}
                          onChange={setGateCode}
                        />
                      </div>
                      <div className="field">
                        <SecretField
                          id="key"
                          className="inp"
                          label="Key Location"
                          value={keyLocation}
                          onChange={setKeyLocation}
                        />
                      </div>
                      <div className="field full">
                        <SecretField
                          id="wifi"
                          className="inp mono"
                          label="Wi-Fi Password"
                          value={wifi}
                          onChange={setWifi}
                        />
                        <span className="hint">Handy for overnight stays and rainy day visits.</span>
                      </div>
                    </div>
                    {visibleHomeFields.length > 0 && (
                      <>
                        <hr className="divider" />
                        <div className="sectlabel">Custom home fields</div>
                        <p className="customfields-note">Set by your Auntie. Ask them to update these.</p>
                        {visibleHomeFields.map((f) => (
                          <div className="customfield-row" key={f.key}>
                            {f.label && <div className="cflabel">{f.label}</div>}
                            <div className="cfvalue">{f.value}</div>
                          </div>
                        ))}
                      </>
                    )}
                  </>
                )}
              </section>

              {/* VET CLINIC CARD */}
              <section className="glass card d3">
                <div className="cardhead">
                  <div className="ic purple">{'\u{1F3E5}'}</div>
                  <div className="htxt">
                    <h3 className="title">Vet Clinic</h3>
                    <p className="sub">The first call your Auntie makes if something is off.</p>
                  </div>
                  {vetPhone && (
                    <div className="actions">
                      <a className="btn ghost" href={`tel:${vetPhone}`} style={{ padding: '9px 14px', fontSize: 13 }}>
                        {'\u{1F4DE}'} Call
                      </a>
                      <a className="btn ghost" href={`sms:${vetPhone}`} style={{ padding: '9px 14px', fontSize: 13 }}>
                        {'\u{1F4AC}'} Text
                      </a>
                    </div>
                  )}
                </div>

                {clinics.length > 0 && (
                  <div className="field full" style={{ marginBottom: 10 }}>
                    <label htmlFor="vetsearch">Search vet clinics</label>
                    <input id="vetsearch" className="inp" type="text" value={vetQuery} onChange={(e) => setVetQuery(e.target.value)} placeholder="Start typing a clinic name…" />
                    {vetMatches.length > 0 && (
                      <div className="suggestlist">
                        {vetMatches.map((c) => (
                          <div className="suggestrow" key={c.id} onClick={() => pickClinic(c)}>
                            <b>{c.isEmergency ? `${c.name} · 24hr` : c.name}</b>
                            {c.address && <small>{c.address}</small>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="grid2">
                  <div className="field">
                    <label htmlFor="clinic">Clinic Name</label>
                    <input id="clinic" className="inp" type="text" value={vetName} onChange={(e) => setVetName(e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="cphone">Clinic Phone</label>
                    <input id="cphone" className="inp mono" type="tel" value={vetPhone} onChange={(e) => setVetPhone(e.target.value)} />
                  </div>
                  <div className="field full">
                    <label htmlFor="caddr">Clinic Address</label>
                    <input id="caddr" className="inp" type="text" value={vetAddress} onChange={(e) => onAddressChange(e.target.value)} />
                    {addressError && <span className="hint" style={{ color: 'var(--coral)' }}>Lookup error: {addressError}</span>}
                    {addressSuggestions.length > 0 && (
                      <div className="suggestlist">
                        {addressSuggestions.slice(0, 5).map((s) => (
                          <div className="suggestrow" key={s.mapbox_id} onClick={() => pickAddressSuggestion(s)}>
                            <b>{s.full_address || s.name}</b>
                            {s.place_formatted && <small>{s.place_formatted}</small>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {!clinicAlreadyOnList(vetName, clinics) && (
                  <div style={{ marginTop: 12 }}>
                    <button className="addfield" type="button" onClick={submitClinicToSharedList} disabled={submittingClinic}>
                      {submittingClinic ? 'Submitting…' : `+ Add "${vetName.trim()}" to the shared vet list`}
                    </button>
                    {submitClinicMsg && <p className="sub" style={{ marginTop: 8 }}>{submitClinicMsg}</p>}
                  </div>
                )}

                <hr className="divider" />

                <div className="sectlabel">
                  After-hours <span className="suggest" style={{ marginLeft: 'auto' }}>{'★'} Suggestion</span>
                </div>
                <div className="grid2">
                  <div className="field">
                    <label htmlFor="ehphone">Emergency clinic phone</label>
                    <input id="ehphone" className="inp mono" type="tel" value={afterHoursVetPhone} onChange={(e) => setAfterHoursVetPhone(e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="ehname">Emergency clinic</label>
                    <input id="ehname" className="inp" type="text" value={afterHoursVetName} onChange={(e) => setAfterHoursVetName(e.target.value)} />
                  </div>
                </div>
              </section>

              {/* EMERGENCY CONTACT CARD — no mockup coverage; ported from TribeScreen.kt */}
              <section className="glass card d4">
                <div className="cardhead">
                  <div className="ic coral">{'\u{1F4DE}'}</div>
                  <div className="htxt">
                    <h3 className="title">Emergency Contact</h3>
                    <p className="sub">Who your Auntie calls if we can&rsquo;t reach you during a visit.</p>
                  </div>
                </div>
                <div className="grid2">
                  <div className="field">
                    <label htmlFor="ecname">Contact Name</label>
                    <input id="ecname" className="inp" type="text" value={emergencyName} onChange={(e) => setEmergencyName(e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="ecphone">Contact Phone</label>
                    <input id="ecphone" className="inp mono" type="tel" value={emergencyPhone} onChange={(e) => setEmergencyPhone(e.target.value)} />
                  </div>
                  <div className="field full">
                    <label htmlFor="ecrel">Relationship (e.g. Neighbor, Sister)</label>
                    <input id="ecrel" className="inp" type="text" value={emergencyRelation} onChange={(e) => setEmergencyRelation(e.target.value)} />
                  </div>
                </div>
              </section>

              {/* HOUSEHOLD MEMBERS — no mockup coverage; ported from HouseholdMembersCard in TribeScreen.kt.
                  PRIMARY-only: listMembers denies a SECONDARY caller, so this card degrades to an
                  inline message rather than the whole screen for that case. */}
              <section className="glass card d4">
                <div className="cardhead">
                  <div className="ic purple">{'\u{1F46A}'}</div>
                  <div className="htxt">
                    <h3 className="title">Household Members</h3>
                    <p className="sub">Adjust what each member of your Tribe can see and do.</p>
                  </div>
                </div>
                {membersQ.isLoading ? (
                  <p className="sub">Loading household members…</p>
                ) : membersQ.isError ? (
                  <p className="sub">Couldn&rsquo;t load household members right now.</p>
                ) : members.length === 0 ? (
                  <p className="sub">No other members yet. Invite a partner, family member, or trusted friend below.</p>
                ) : (
                  members.map((m) => <MemberPermissionRow key={m.uid} kinfolkId={kinfolkId} member={m} />)
                )}
              </section>

              {/* INVITE A KINFOLK — no mockup coverage; ported from SecondaryInviteCard in TribeScreen.kt */}
              <InviteKinfolkCard kinfolkId={kinfolkId} />

              {/* SAVE BAR */}
              <section style={{ marginTop: 6 }}>
                <div className="savebar">
                  <button className="btn grad" type="button" onClick={() => void handleSave()} disabled={saving || effectiveDisplayName.trim().length === 0}>
                    {'\u{1F4BE}'} {saving ? 'Saving…' : 'Save Changes'}
                  </button>
                  {status && (
                    <span className={`status ${status.startsWith('Saved') ? '' : 'err'}`}>
                      <span className="dot" />
                      {status}
                    </span>
                  )}
                  {effectiveDisplayName.trim().length === 0 && <span className="sub">Add a display name to save.</span>}
                </div>
              </section>
            </>
          )}
        </div>

        <p className="footnote">
          Cared for by <b>Tribe Tails Pet Care</b>
        </p>
      </div>
    </>
  );
}

/** Generic renderer for an admin-authored form schema (getFormSchema). */
function SchemaSection(props: { schema: FormSchemaDto; values: Record<string, string>; onChange: (next: Record<string, string>) => void }) {
  const { schema, values, onChange } = props;
  function set(key: string, v: string) {
    onChange({ ...values, [key]: v });
  }
  return (
    <>
      {schema.sections.map((section, i) => (
        <div key={`${section.title}-${i}`} style={{ marginBottom: 8 }}>
          {section.title && <div className="sectlabel">{section.title}</div>}
          {section.description && <p className="sub" style={{ marginBottom: 10 }}>{section.description}</p>}
          <div className="grid2">
            {section.fields.map((field) => (
              <SchemaFieldInput key={field.key} field={field} value={values[field.key] ?? field.defaultValue ?? ''} onChange={(v) => set(field.key, v)} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function SchemaFieldInput(props: { field: FormFieldDto; value: string; onChange: (v: string) => void }) {
  const { field, value, onChange } = props;
  const wide = field.type === 'textarea' || field.type === 'multiselect' || field.type === 'select';
  const wrapperClass = wide ? 'field full' : 'field';

  if (field.type === 'checkbox') {
    return (
      <div className="field full">
        <label className="togglerow">
          <span className="tlabel">
            {field.label}
            {field.required && ' *'}
          </span>
          <span className="toggle">
            <input type="checkbox" checked={value === 'true'} onChange={(e) => onChange(e.target.checked ? 'true' : 'false')} />
            <span className="track">
              <span className="thumb" />
            </span>
          </span>
        </label>
        {field.helperText && <span className="hint">{field.helperText}</span>}
      </div>
    );
  }

  if (field.type === 'textarea') {
    return (
      <div className={wrapperClass}>
        <label>{field.label}{field.required && ' *'}</label>
        <textarea className="inp" value={value} placeholder={field.placeholder ?? undefined} onChange={(e) => onChange(e.target.value)} />
        {field.helperText && <span className="hint">{field.helperText}</span>}
      </div>
    );
  }

  if (field.type === 'select' || field.type === 'multiselect') {
    const options = field.options ?? [];
    return (
      <div className={wrapperClass}>
        <label>{field.label}{field.required && ' *'}</label>
        <select className="inp" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{field.placeholder ?? 'Choose…'}</option>
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        {field.helperText && <span className="hint">{field.helperText}</span>}
      </div>
    );
  }

  // Secret fields (gate code, key location, wifi password) should use the masked reveal component.
  const isSecretField = ['gateCode', 'keyLocation', 'wifiPassword'].includes(field.key);
  if (isSecretField) {
    return (
      <div className={wrapperClass}>
        <SecretField
          label={`${field.label}${field.required ? ' *' : ''}`}
          value={value}
          onChange={onChange}
          {...(field.placeholder ? { placeholder: field.placeholder } : {})}
          className="inp"
        />
        {field.helperText && <span className="hint">{field.helperText}</span>}
      </div>
    );
  }

  const inputType = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : field.type === 'phone' ? 'tel' : field.type === 'email' ? 'email' : 'text';
  return (
    <div className={wrapperClass}>
      <label>{field.label}{field.required && ' *'}</label>
      <input className="inp" type={inputType} value={value} placeholder={field.placeholder ?? undefined} onChange={(e) => onChange(e.target.value)} />
      {field.helperText && <span className="hint">{field.helperText}</span>}
    </div>
  );
}

/** One secondary's editable-permissions block, ported from MemberPermissionRow in TribeScreen.kt. */
function MemberPermissionRow(props: { kinfolkId: string | undefined; member: MemberDto }) {
  const { kinfolkId, member } = props;
  const queryClient = useQueryClient();
  const [canEditPets, setCanEditPets] = useState(member.permissions.kin_edit);
  const [canAccessHome, setCanAccessHome] = useState(member.permissions.home_access);
  const [canDirectMessage, setCanDirectMessage] = useState(member.permissions.messaging_direct);
  // RULING: "Primary kinfolk is allowed to set the permissions of the secondary,
  // including billing if they want." Billing was display-only on this screen
  // because the callable silently dropped the key; it accepts it now, so the
  // household's primary gets the control the ruling says is theirs.
  const [canHandleBilling, setCanHandleBilling] = useState(member.permissions.billing_full);

  const save = useMutation({
    mutationFn: () =>
      updateSecondaryPermissions({
        familyId: kinfolkId ?? '',
        targetUid: member.uid,
        permissions: {
          billing_full: canHandleBilling,
          messaging_direct: canDirectMessage,
          // Preserved as-is: not exposed as a toggle here.
          messaging_group: member.permissions.messaging_group,
          kin_edit: canEditPets,
          home_access: canAccessHome,
        },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['members', kinfolkId] }),
  });

  const title = member.secondaryLabel?.trim() || member.invitedEmail?.trim() || 'Member';
  const subParts = [member.invitedEmail && member.invitedEmail !== title ? member.invitedEmail : null, memberStatusLabel(member.status)].filter(Boolean);

  return (
    <div className="memberrow">
      <div className="mname">{title}</div>
      <div className="msub">{subParts.join(' · ')}</div>
      <div className="mtoggles">
        <label className="togglerow">
          <span className="tlabel">Can edit Kin</span>
          <span className="toggle">
            <input type="checkbox" checked={canEditPets} onChange={(e) => setCanEditPets(e.target.checked)} />
            <span className="track">
              <span className="thumb" />
            </span>
          </span>
        </label>
        <label className="togglerow">
          <span className="tlabel">Home access (gate code, Wi-Fi)</span>
          <span className="toggle">
            <input type="checkbox" checked={canAccessHome} onChange={(e) => setCanAccessHome(e.target.checked)} />
            <span className="track">
              <span className="thumb" />
            </span>
          </span>
        </label>
        <label className="togglerow">
          <span className="tlabel">Direct messaging</span>
          <span className="toggle">
            <input type="checkbox" checked={canDirectMessage} onChange={(e) => setCanDirectMessage(e.target.checked)} />
            <span className="track">
              <span className="thumb" />
            </span>
          </span>
        </label>
        <label className="togglerow">
          <span className="tlabel">Billing (invoices, payment methods)</span>
          <span className="toggle">
            <input type="checkbox" checked={canHandleBilling} onChange={(e) => setCanHandleBilling(e.target.checked)} />
            <span className="track">
              <span className="thumb" />
            </span>
          </span>
        </label>
      </div>
      <button className="btn ghost block" type="button" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? 'Saving…' : 'Save'}
      </button>
      {save.isSuccess && <p className="sub" style={{ color: 'var(--teal)', marginTop: 6 }}>Saved.</p>}
      {save.isError && <p className="sub" style={{ color: 'var(--coral)', marginTop: 6 }}>Save failed. Try again.</p>}
    </div>
  );
}

/** Invite a secondary kinfolk, ported from SecondaryInviteCard in TribeScreen.kt. */
function InviteKinfolkCard(props: { kinfolkId: string | undefined }) {
  const { kinfolkId } = props;
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('');
  const [canEditPets, setCanEditPets] = useState(false);
  const [canAccessHome, setCanAccessHome] = useState(false);

  const invite = useMutation({
    mutationFn: () =>
      addSecondaryContact({
        ...(kinfolkId !== undefined ? { kinfolkId } : {}),
        invitedEmail: email.trim(),
        ...(role.trim() ? { secondaryLabel: role.trim() } : {}),
        permissions: { kin_edit: canEditPets, home_access: canAccessHome },
      }),
    onSuccess: () => {
      setEmail('');
      setRole('');
      setCanEditPets(false);
      setCanAccessHome(false);
    },
  });

  return (
    <section className="glass card d4">
      <div className="cardhead">
        <div className="ic teal">{'\u{1F46A}'}</div>
        <div className="htxt">
          <h3 className="title">Invite a Kinfolk</h3>
          <p className="sub">Add a partner, family member, or trusted friend to your Tribe.</p>
        </div>
      </div>
      <div className="grid2">
        <div className="field full">
          <label htmlFor="inv-email">Email</label>
          <input id="inv-email" className="inp" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field full">
          <label htmlFor="inv-role">Their role (e.g. Co-Parent, Sister)</label>
          <input id="inv-role" className="inp" type="text" value={role} onChange={(e) => setRole(e.target.value)} />
        </div>
      </div>
      <label className="togglerow">
        <span className="tlabel">Can edit Kin</span>
        <span className="toggle">
          <input type="checkbox" checked={canEditPets} onChange={(e) => setCanEditPets(e.target.checked)} />
          <span className="track">
            <span className="thumb" />
          </span>
        </span>
      </label>
      <label className="togglerow">
        <span className="tlabel">Home access (gate code, Wi-Fi)</span>
        <span className="toggle">
          <input type="checkbox" checked={canAccessHome} onChange={(e) => setCanAccessHome(e.target.checked)} />
          <span className="track">
            <span className="thumb" />
          </span>
        </span>
      </label>
      <button className="btn grad block" type="button" style={{ marginTop: 12 }} onClick={() => invite.mutate()} disabled={invite.isPending || !email.includes('@')}>
        {invite.isPending ? 'Sending…' : 'Send Invite'}
      </button>
      {invite.isSuccess && <p className="sub" style={{ color: 'var(--teal)', marginTop: 8 }}>Invite sent.</p>}
      {invite.isError && <p className="sub" style={{ color: 'var(--coral)', marginTop: 8 }}>Invite failed. Try again.</p>}
    </section>
  );
}
