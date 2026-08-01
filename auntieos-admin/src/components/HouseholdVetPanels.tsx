import { AsyncRegion } from './AsyncRegion';
import { Banner } from './Banner';
import { DenPanel } from './DenScreenKit';
import { useOneShot } from '../lib/useOneShot';
import { useCollection } from '../lib/firestore';
import { getHouseholdData, type HouseholdRecord } from '../api/householdData';
import { VET_CLINICS_QUERY, type VetClinic } from '../api/vetClinics';
import { resolveHouseholdVet, hasVet, type ResolvedVet } from '../lib/householdVet';

/**
 * The household's vet, READ-ONLY, for the household profile.
 *
 * Operator ruling 2026-08-01: "vet info lives on household data, it can be seen
 * on the kin profile". The profile used to render `kinfolk.vetClinicName` and
 * friends, a second writable copy of a fact `household_data` already owned.
 * This resolves the canonical record instead, so the profile, the Household
 * Data screen and the vet clinics manager cannot disagree about a household's
 * vet: there is one record and one resolver behind all three.
 */
export function HouseholdVetPanels({ kinfolkId }: { kinfolkId: string }) {
  const household = useOneShot(
    () => getHouseholdData(kinfolkId),
    'getHouseholdData',
  );
  const clinics = useCollection<VetClinic>(VET_CLINICS_QUERY);

  return (
    <AsyncRegion
      state={household}
      what="the household's vet"
      // A household with no record is not an empty state worth a banner here:
      // the panels below simply do not render. The profile has plenty else.
      isEmpty={() => false}
      empty={null}
    >
      {(record) => {
        // Held until the catalog lands. A linked id cannot be resolved without
        // it, and rendering early would flash every linked vet as "broken link".
        if (clinics.status === 'loading') {
          return <DenPanel title="Vet clinic">Reading the shared clinic catalog…</DenPanel>;
        }
        if (clinics.status === 'error') {
          return (
            <DenPanel title="Vet clinic">
              <Banner tone="warning" title="The shared clinic catalog didn't load">
                {clinics.message} The vet on file cannot be shown until it does. It is unchanged.
              </Banner>
            </DenPanel>
          );
        }

        const vet = resolveHouseholdVet(record as HouseholdRecord | null, clinics.data);
        return (
          <>
            <VetPanel title="Vet clinic" vet={vet.primary} />
            <VetPanel
              title="Emergency vet"
              subtitle="The 24 hour clinic for this household."
              vet={vet.emergency}
            />
          </>
        );
      }}
    </AsyncRegion>
  );
}

function VetPanel({
  title,
  subtitle,
  vet,
}: {
  title: string;
  subtitle?: string;
  vet: ResolvedVet;
}) {
  // A dangling link is shown even though there is nothing to show, because
  // silence would read as "this household has no vet" when it actually has a
  // broken one. That difference matters at a doorstep.
  if (!hasVet(vet) && !vet.dangling) return null;

  return (
    <DenPanel title={title} {...(subtitle === undefined ? {} : { subtitle })}>
      {vet.dangling ? (
        <Banner tone="warning" title="This household's vet no longer exists">
          The record points at a clinic that has been removed from the catalog. Pick the vet
          again on Household Data.
        </Banner>
      ) : (
        <>
          <dl className="kprofile__facts">
            <Fact label="Clinic" value={vet.name} />
            <Fact label="Address" value={vet.address} />
            <Fact label="Phone" value={vet.phone} mono />
            <Fact label="Hours" value={vet.hours} />
          </dl>
          {vet.archived && (
            <Banner tone="info" title="This clinic has been retired from the bank">
              It is still this household's vet and the details above are current. It just cannot
              be chosen by anyone new.
            </Banner>
          )}
          {!vet.linked && hasVet(vet) && (
            <Banner tone="warning" title="Not linked to the catalog">
              These details were typed before the shared vet bank existed, so correcting this
              clinic in the vet clinics manager will not update this household. Re-pick the vet
              on Household Data to link them.
            </Banner>
          )}
        </>
      )}
    </DenPanel>
  );
}

/** Local copy of the profile's fact row: blank values are omitted, not shown. */
function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  if (value.trim() === '') return null;
  return (
    <div className="kprofile__fact">
      <dt>{label}</dt>
      <dd className={mono === true ? 'mono' : undefined}>{value}</dd>
    </div>
  );
}
