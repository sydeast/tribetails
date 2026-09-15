import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  KINFOLK_QUERY,
  KIN_QUERY,
  KINFOLK_SORT_OPTIONS,
  KIN_SORT_OPTIONS,
  SORT_OPTION_DEFAULT,
  TAG_FILTER_ALL,
  filterSortKinfolk,
  filterSortKin,
  tagFilterOptions,
  activeKinByKinfolk,
  kinfolkDisplayName,
  householdSubtitle,
  initialsOf,
  type Kinfolk,
  type Kin,
  type SortOption,
} from '../api/directory';
import { useCollection } from '../lib/firestore';
import { useAuth } from '../lib/auth';
import { str } from '../lib/coerce';
import { useRovingTabs } from '../lib/useRovingTabs';
import { hasEmergencyContact } from '../api/emergencyContacts';
import { DenScreenHeading, StatusPill, EmptyHint, type DenTone } from '../components/DenScreenKit';
import { LoadingRow } from '../components/LoadingRow';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { Avatar } from '../components/Avatar';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { AddKinfolkDialog } from '../components/AddKinfolkDialog';
import { NoEmergencyContactFlag } from '../components/NoEmergencyContactFlag';
import { AddKinDialog, type KinfolkOption } from '../components/AddKinDialog';
import { EntityCardGrid } from '../components/EntityCardGrid';
import { KinfolkProfile } from './KinfolkProfile';
import { KinView } from './KinView';
import './Directory.css';

type DirectoryTab = 'kinfolk' | 'kin';

/** No icon package is installed here (see Buttons.tsx / FormSchemas.tsx glyph precedent). */
function PawGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
      <circle cx="7" cy="7.4" r="2.1" />
      <circle cx="12.4" cy="5.4" r="2.1" />
      <circle cx="17.5" cy="7.4" r="2.1" />
      <path d="M12.3 10.4c-3.3 0-6.2 2.6-6.2 5.5 0 1.8 1.5 3 3.4 3 1.1 0 1.8-.5 2.7-.5.9 0 1.7.5 2.7.5 2 0 3.4-1.2 3.4-3 0-2.9-2.9-5.5-6-5.5Z" />
    </svg>
  );
}

/** Ports FormSchemas.tsx's PlusGlyph verbatim: no icon package installed here either. */
function PlusGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** The mock's search glyph (`.search svg`), inline for the same reason as PawGlyph. */
function SearchGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3-3" />
    </svg>
  );
}

/** The mock's card-footer phone glyph (`.krow .contact svg`, first). */
function PhoneGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 5c0 9 6 15 15 15l2-3-4-2-2 2c-3-1-6-4-7-7l2-2-2-4z" />
    </svg>
  );
}

/** The mock's card-footer mail glyph (`.krow .contact svg`, second). */
function MailGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}

/** The mock's sort-pill chevron (`.sortpill svg`). */
function ChevronGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function statusTone(status: string): DenTone {
  const s = status.toLowerCase();
  if (s === 'active') return 'success';
  if (s === 'inactive') return 'muted';
  if (s === 'archived') return 'warning';
  if (s === 'prospect') return 'teal';
  return 'neutral';
}

/**
 * The card's status badge, in the mock's top-right corner (`.badge`).
 *
 * The mock draws a badge only on the exception: five active households carry no
 * status word at all, and the sixth wears "New". So an active row is silent
 * here, and a row in any other state (inactive, archived, prospect, or a status
 * this screen does not know) wears the kit's StatusPill where the mock puts its
 * badge. Blank stays blank: an absent status is not a state to announce.
 *
 * The compact size (#780) is the mock's `.badge` itself, 9.5px on 4px 9px; the
 * kit's default capsule is the detail screens' `.statuspill` and sat larger in
 * the corner than the mock draws it.
 */
function CardBadge({ status }: { status: string }) {
  const label = status.trim().toLowerCase();
  if (label === '' || label === 'active') return null;
  return (
    <span className="directory__badge">
      <StatusPill label={label} tone={statusTone(label)} size="compact" />
    </span>
  );
}

interface KinfolkCardProps {
  kf: Kinfolk;
  kin: Kin[];
  /** True while the shared Kin stream is still loading, disclose it, don't claim "No kin on file". */
  kinPending: boolean;
  /** Absent until a profile route is wired: the card then renders STATIC, never a no-op button. */
  onClick?: () => void;
}

/**
 * Household card. AO-11 fix: the wasm card was a FIXED-height Box, which
 * clipped the "+N more" overflow chip for a household with 4+ pets, pets
 * silently disappeared with no visible affordance. This card has no fixed
 * height and no `overflow: hidden` anywhere in its stylesheet (Directory.css),
 * so the pet-chip row (`flex-wrap: wrap`) always grows the card rather than
 * clipping it, and the overflow chip is never hidden.
 */
function KinfolkCard({ kf, kin, kinPending, onClick }: KinfolkCardProps) {
  const displayName = kinfolkDisplayName(kf);
  const subtitle = householdSubtitle(kf, kin);
  const shown = kin.slice(0, 3);
  const overflow = kin.length - shown.length;

  const body = (
    <>
        <CardBadge status={str(kf.status)} />
        <span className="directory__card-head">
          <Avatar
            label={displayName}
            imageUrl={kf.profilePictureUrl}
            initials={initialsOf(displayName)}
            size={50}
            shape="rounded"
            gradientSeed={kf._id !== '' ? kf._id : displayName}
          />
          <span className="directory__card-heading">
            <span className="directory__card-name">{displayName}</span>
            {subtitle !== '' && <span className="directory__card-sub">{subtitle}</span>}
          </span>
        </span>

        {!hasEmergencyContact(kf as unknown as Record<string, unknown>) && (
          <span className="directory__ec-flag">
            <NoEmergencyContactFlag compact />
          </span>
        )}

        <span className="directory__pets">
          {kin.length === 0 ? (
            <span className="directory__pets-empty">
              {kinPending ? 'Loading kin…' : 'No kin on file'}
            </span>
          ) : (
            <>
              {shown.map((k) => (
                <span key={k._id} className="directory__pet-chip">
                  {/* The mock's chip leads with the pet's own photo, framed in a
                      circle; the paw sits underneath for a pet with none. */}
                  <Avatar
                    label={str(k.name)}
                    imageUrl={k.profilePictureUrl}
                    glyph={<PawGlyph />}
                    size={28}
                    ring={false}
                    gradientSeed={k._id !== '' ? k._id : str(k.name)}
                  />
                  <span className="directory__pet-chip-label">{str(k.name)}</span>
                </span>
              ))}
              {overflow > 0 && (
                <span className="directory__pet-chip directory__pet-chip--overflow">
                  +{overflow} more
                </span>
              )}
            </>
          )}
        </span>

        <span className="directory__card-footer">
          <span className="directory__card-contact">
            {/*
              str() before the !== '' test: an ABSENT phone/email is `undefined`,
              which passes `!== ''` and would render the literal "undefined" as
              a contact line. The empty-string default keeps the row hidden,
              exactly as it was for a doc with a blank field.
            */}
            {str(kf.phoneNumber) !== '' && (
              <span className="directory__card-contact-item">
                <PhoneGlyph />
                {str(kf.phoneNumber)}
              </span>
            )}
            {str(kf.email) !== '' && (
              <span className="directory__card-contact-item">
                <MailGlyph />
                {str(kf.email)}
              </span>
            )}
          </span>
        </span>
    </>
  );

  // Static, non-interactive card unless a profile handler is wired: a live
  // no-op button is the dead-control anti-pattern (see ControlShell).
  return (
    <li className="directory__cell">
      {onClick ? (
        <button type="button" className="directory__card lift" onClick={onClick}>
          {body}
        </button>
      ) : (
        <div className="directory__card directory__card--static">{body}</div>
      )}
    </li>
  );
}

interface KinCardProps {
  kin: Kin;
  /** Absent until a kin route is wired: the card then renders STATIC, never a no-op button. */
  onClick?: () => void;
}

/** Kin (pet) card for the Kin tab. Mirrors KinfolkCard's frame, no pet-chip row. */
function KinCard({ kin, onClick }: KinCardProps) {
  // str() on every part: an absent species/breed/age is `undefined`, which
  // survives the `!== ''` filter and would join as "undefined · undefined".
  const age = str(kin.age);
  const detail = [str(kin.species), str(kin.breed), age !== '' ? `${age} yrs` : '']
    .filter((s) => s !== '')
    .join(' · ');

  const body = (
    <>
        <CardBadge status={str(kin.status)} />
        <span className="directory__card-head">
          <Avatar
            label={str(kin.name)}
            imageUrl={kin.profilePictureUrl}
            glyph={<PawGlyph />}
            size={50}
            shape="rounded"
            gradientSeed={kin._id !== '' ? kin._id : str(kin.name)}
          />
          <span className="directory__card-heading">
            <span className="directory__card-name">{str(kin.name)}</span>
            {detail !== '' && <span className="directory__card-sub">{detail}</span>}
          </span>
        </span>

        <span className="directory__card-footer">
          <span className="directory__card-contact">
            {str(kin.sex) !== '' && (
              <span className="directory__card-contact-item">{str(kin.sex)}</span>
            )}
          </span>
        </span>
    </>
  );

  return (
    <li className="directory__cell">
      {onClick ? (
        <button type="button" className="directory__card lift" onClick={onClick}>
          {body}
        </button>
      ) : (
        <div className="directory__card directory__card--static">{body}</div>
      )}
    </li>
  );
}

/**
 * Why nothing is showing. The old copy always blamed the search box, which
 * became a lie the moment a tag filter could empty the list on its own: an
 * operator who cleared the search and still saw "No matches for" had no way to
 * learn the tag was the thing holding rows back.
 */
function noMatchHint(query: string, tag: string): string {
  const q = query.trim();
  if (q !== '' && tag !== '') return `No matches for "${q}" tagged "${tag}".`;
  if (tag !== '') return `Nothing here is tagged "${tag}".`;
  return `No matches for "${q}".`;
}

/** The open kin detail view, plus the household its breadcrumb names. */
interface OpenKin {
  id: string;
  name: string;
  household?: { id: string; name: string };
}

interface DirectoryProps {
  /**
   * Card-open override. Propless (the router default), a kinfolk card NAVIGATES
   * to `/directory/{kinfolkId}`; the profile is then mounted by that route, not
   * by local state, so the URL is what says which household is open. A caller
   * can pass its own handler to take over selection instead.
   */
  onSelectKinfolk?: (id: string) => void;
  /**
   * Kin card-open override. Propless (the router default), a kin card opens the
   * in-screen `KinView` detail. A caller can pass its own handler to take over.
   */
  onSelectKin?: (id: string) => void;
  /**
   * The household whose profile is open, supplied by the `/directory/{id}`
   * route. This is the ONLY thing that opens the profile: there is no local
   * "which household is open" state to disagree with the address bar.
   */
  initialKinfolkId?: string;
  /**
   * Called when the household profile is closed. The deep-link route uses it
   * to navigate back to `/directory`, so the URL never keeps pointing at a
   * profile the operator has already left.
   */
  onProfileClose?: () => void;
}

/**
 * Admin Directory ("The Den · Directory"). Two tabs, ported from
 * DirectoryScreen.kt/DirectoryListScreen: Kinfolk (households, with their
 * active kin as chips on the card) and Kin (every pet, standalone).
 *
 * Two independent bounded, server-ordered streams back both tabs (see
 * KINFOLK_QUERY / KIN_QUERY in api/directory.ts): the Kin stream is read here
 * even while on the Kinfolk tab, because a household card's pet chips come
 * from it (one screen-level subscription, no N+1 per-card listener, same
 * reasoning as allKinStream() in DirectoryListScreen.kt). Only the LIST ships
 * here; onSelectKinfolk / onSelectKin are placeholder props for the
 * not-yet-built profile/edit screens (KinfolkProfileScreen, KinViewScreen,
 * KinEditScreen), same pattern as FormSchemas' onSelect/onNew.
 */
export function Directory({
  onSelectKinfolk,
  onSelectKin,
  initialKinfolkId,
  onProfileClose,
}: DirectoryProps) {
  const kinfolkState = useCollection<Kinfolk>(KINFOLK_QUERY);
  const kinState = useCollection<Kin>(KIN_QUERY);
  const navigate = useNavigate();
  // #890: Add Kinfolk keeps a household waiting on its Emergency Contact per operator.
  const auth = useAuth();

  const [tab, setTab] = useState<DirectoryTab>('kinfolk');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortOption>(SORT_OPTION_DEFAULT);
  /**
   * #713: narrow the list to one tag. Per tab, because the two vocabularies are
   * separate lists and a household tag would match nothing on the Kin tab.
   * Client-side over rows this screen already holds, so no read and no index.
   */
  const [kinfolkTag, setKinfolkTag] = useState(TAG_FILTER_ALL);
  const [kinTag, setKinTag] = useState(TAG_FILTER_ALL);
  // The household profile detail view. It is opened by the ROUTE, never by
  // local state: a card click navigates to `/directory/{kinfolkId}` and this
  // screen re-mounts under that route with the id as a prop. That is what makes
  // a household linkable, reloadable, and reachable with browser Back.
  const openKinfolkId = initialKinfolkId ?? null;
  // Kin (pet) detail: same sibling-view pattern as the household profile.
  // `household` is carried alongside because the kin detail's breadcrumb needs
  // it (the mock's trail is Directory / Lorna Wren / Biscuit) and the kin doc
  // only holds an id. Resolved here, from streams this screen already has, and
  // left undefined when it cannot be resolved rather than guessed at.
  const [openKinId, setOpenKinId] = useState<OpenKin | null>(null);

  // Roving-tabindex keyboard nav for the Kinfolk/Kin tablist below
  // (Left/Right, Home/End, roving tabIndex).
  const { getTabProps } = useRovingTabs({ count: 2, activeIndex: tab === 'kinfolk' ? 0 : 1 });

  // The two DEFERRED create flows (this screen was read-only until now).
  // Both dialogs close themselves on success; neither manually refetches,
  // KINFOLK_QUERY / KIN_QUERY are live onSnapshot streams (useCollection), so
  // the new row appears in the grid the instant the write lands.
  const [showAddKinfolk, setShowAddKinfolk] = useState(false);
  const [showAddKin, setShowAddKin] = useState(false);
  /**
   * #829 review item 6: a household Add created but left without its Emergency
   * Contact (the contact save failed and the operator closed the dialog). Named
   * here with a link, so it is fixed on that household rather than Added again.
   */
  const [leftWithoutContactId, setLeftWithoutContactId] = useState<string | null>(null);

  // "Add kin" needs a household picker; Directory already subscribes to the
  // full Kinfolk stream for its own tab, so the picker's options are derived
  // from that, not a second listener on the same collection.
  const kinfolkOptions: KinfolkOption[] = useMemo(() => {
    if (kinfolkState.status !== 'ready') return [];
    return filterSortKinfolk(kinfolkState.data, '', SORT_OPTION_DEFAULT).map((kf) => ({
      id: kf._id,
      label: kinfolkDisplayName(kf),
    }));
  }, [kinfolkState]);

  // The tag options each tab offers, derived from the rows it is showing. Built
  // from the loaded docs rather than from the settings vocabulary so the list
  // never offers a tag that would narrow to nothing, and so this screen keeps
  // its two reads.
  const kinfolkTagOptions = useMemo(
    () => (kinfolkState.status === 'ready' ? tagFilterOptions(kinfolkState.data) : []),
    [kinfolkState],
  );
  const kinTagOptions = useMemo(
    () => (kinState.status === 'ready' ? tagFilterOptions(kinState.data) : []),
    [kinState],
  );

  /**
   * A tag filter that no row can satisfy any more falls back to "All tags".
   *
   * This PR is what makes that reachable: filter the Directory by "VIP", delete
   * "VIP" in Settings, and the live stream drops every assignment. The option
   * list empties, the picker hides itself, and without this the list would sit
   * on "Nothing here is tagged VIP" with no control left to clear it. Derived
   * rather than reset in an effect, so there is no window where the state and
   * the rendered list disagree.
   */
  const activeKinfolkTag = kinfolkTagOptions.includes(kinfolkTag) ? kinfolkTag : TAG_FILTER_ALL;
  const activeKinTag = kinTagOptions.includes(kinTag) ? kinTag : TAG_FILTER_ALL;

  function selectTab(next: DirectoryTab) {
    setTab(next);
    setQuery(''); // ports `onTabChange { vm.clearSearch() }`
    // "Recently Created" has no backing field on Kin (KIN_SORT_OPTIONS omits
    // it), don't silently carry a selection over into a no-op sort.
    if (next === 'kin' && sort === 'recently_created') setSort(SORT_OPTION_DEFAULT);
  }

  // Single Kin subscription for the whole screen, grouped once. Removes the
  // per-card N+1 listener the old wasm KinfolkCard used to open.
  const kinByKinfolk = useMemo(() => {
    if (kinState.status !== 'ready') return new Map<string, Kin[]>();
    return activeKinByKinfolk(kinState.data);
  }, [kinState]);

  /**
   * The household a kin card belongs to, for the kin detail's breadcrumb.
   *
   * Returns undefined when the kin carries no `kinfolkId`, or names a household
   * this stream does not hold, or the stream has not arrived: a trail step is a
   * claim about where you are, and an invented one sends the operator to a
   * household the pet does not live in. The crumb is simply omitted instead.
   */
  function householdOf(kin: Kin): { id: string; name: string } | undefined {
    const id = str(kin.kinfolkId);
    if (id === '' || kinfolkState.status !== 'ready') return undefined;
    const owner = kinfolkState.data.find((kf) => kf._id === id);
    return owner === undefined ? undefined : { id, name: kinfolkDisplayName(owner) };
  }

  // Disclosed to household cards: while the shared Kin stream is still loading,
  // kinByKinfolk is empty for every card, so an empty pet row must read
  // "Loading kin…", never a false "No kin on file".
  const kinPending = kinState.status === 'loading';

  // Tab-pill counts: shown ONLY once the respective stream is genuinely ready,
  // never fabricated as 0 while loading/erroring (StatCard's ResolvedScalar policy).
  const kinfolkCount = kinfolkState.status === 'ready' ? kinfolkState.data.length : null;
  const kinCount =
    kinState.status === 'ready'
      ? kinState.data.filter((k) => k.status !== 'archived').length
      : null;

  // KIN DETAIL WINS OVER THE PROFILE, and the order matters. A kin row on the
  // household profile opens this view, and the profile is still mounted under
  // it (its `openKinfolkId` comes from the route, which has not changed), so
  // checking the profile first would swallow the drill-down. Closing this view
  // therefore lands back on whichever screen opened it: the profile, or the
  // Directory's own Kin tab. `openedFrom` tells KinView which of the two that
  // is, so its Back button and its trail can name the destination correctly
  // (#689). It is read off the mount, not stored: a profile that is open is a
  // profile this view was drilled into from.
  if (openKinId !== null) {
    return (
      <KinView
        kinId={openKinId.id}
        kinName={openKinId.name}
        {...(openKinId.household ? { household: openKinId.household } : {})}
        openedFrom={openKinfolkId !== null ? 'profile' : 'directory'}
        onBack={() => setOpenKinId(null)}
      />
    );
  }

  // Household profile takes over the screen when a card is opened (propless mount).
  // The kin come from the KIN_QUERY stream this screen already holds (no second read).
  if (openKinfolkId !== null) {
    const kf =
      kinfolkState.status === 'ready' ? kinfolkState.data.find((k) => k._id === openKinfolkId) : undefined;
    return (
      <KinfolkProfile
        kinfolkId={openKinfolkId}
        kinfolkName={kf ? kinfolkDisplayName(kf) : ''}
        kin={kinByKinfolk.get(openKinfolkId) ?? []}
        // Told apart from "this household has no pets", so the profile does not
        // stamp "0 kin" on a read that has not landed.
        kinPending={kinPending}
        // The mock draws every kin row on the profile as a chevroned row that
        // opens the pet. This screen already owns that swap for its own Kin tab,
        // so the profile's rows go through the same one rather than inventing a
        // second way in.
        onOpenKin={(k) => {
          const household = householdOf(k);
          setOpenKinId({
            id: k._id,
            name: str(k.name),
            ...(household ? { household } : {}),
          });
        }}
        onBack={() => {
          // The COLD-ARRIVAL branch of the profile's Back (#689): the profile
          // steps back through history whenever there is an entry behind it,
          // and reaches this only when a bookmark or a typed URL opened it with
          // nothing behind it at all. Closing is a navigation even then, so
          // `onProfileClose` is what the route passes; propless (never reached
          // today, the profile only mounts under the route) falls back to the
          // list URL rather than to a silently unchanged screen.
          if (onProfileClose) onProfileClose();
          else void navigate({ to: '/directory' });
        }}
      />
    );
  }

  return (
    <div className="screen">
      {/* d1 / d2: the Den entrance stagger (styles/base.css), heading then
          controls. The list itself is deliberately NOT staggered: it arrives
          from a live Firestore stream, so its rows are already appearing on
          their own schedule and a second animation on top reads as a glitch. */}
      <div className="d1">
        <DenScreenHeading
          kicker="The Den · Directory"
          title="Your"
          accentTail="kinfolk"
          subtitle="Every household and kin on file, streamed live from Firestore."
          trailing={
            <div className="directory__header-actions">
              <PrimaryButton
                label="Add kinfolk"
                onClick={() => setShowAddKinfolk(true)}
                leading={<PlusGlyph />}
              />
              <GhostButton
                label="Add kin"
                onClick={() => setShowAddKin(true)}
                leading={<PlusGlyph />}
              />
            </div>
          }
        />
      </div>

      {leftWithoutContactId !== null && (
        <Banner
          tone="warning"
          title="A household was created without an Emergency Contact"
          onDismiss={() => setLeftWithoutContactId(null)}
          trailing={
            <GhostButton
              label="Open the household"
              onClick={() => {
                const id = leftWithoutContactId;
                setLeftWithoutContactId(null);
                void navigate({ to: '/directory/$kinfolkId', params: { kinfolkId: id } });
              }}
            />
          }
        >
          Its contact did not save. Add the contact on that household rather than adding the household again.
        </Banner>
      )}

      <div className="directory__controls d2">
        <div className="directory__tabs" role="tablist" aria-label="Directory view">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'kinfolk'}
            className="directory__tab"
            onClick={() => selectTab('kinfolk')}
            {...getTabProps(0)}
          >
            Kinfolk{' '}
            {kinfolkCount !== null && <span className="directory__tab-count">{kinfolkCount}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'kin'}
            className="directory__tab"
            onClick={() => selectTab('kin')}
            {...getTabProps(1)}
          >
            Kin{' '}
            {kinCount !== null && <span className="directory__tab-count">{kinCount}</span>}
          </button>
        </div>

        {/* The mock's `.search`: a glyph leading the field inside one bordered box. */}
        <label className="directory__search">
          <span className="directory__search-glyph">
            <SearchGlyph />
          </span>
          <input
            type="search"
            className="directory__search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              tab === 'kinfolk'
                ? 'Search by name, phone, or email'
                : 'Search by name, species, or breed'
            }
            aria-label={
              tab === 'kinfolk'
                ? 'Search kinfolk by name, phone, or email'
                : 'Search kin by name, species, or breed'
            }
          />
        </label>

        {/*
          The tag filter. Rendered only once the tab's stream is ready AND some
          row actually carries a tag: an empty picker on a tribe that has not
          tagged anyone is a dead control, and one offered while the stream is
          still loading would claim "no tags" about rows it has not read.
          Each tab keeps its own selection, because household tags and Kin tags
          are separate vocabularies and carrying one across would filter the
          other list down to nothing.
        */}
        {(tab === 'kinfolk' ? kinfolkTagOptions : kinTagOptions).length > 0 && (
          <label className="directory__sort">
            <span className="directory__sort-label">Tag</span>
            <select
              className="directory__sort-select"
              value={tab === 'kinfolk' ? activeKinfolkTag : activeKinTag}
              onChange={(e) =>
                tab === 'kinfolk' ? setKinfolkTag(e.target.value) : setKinTag(e.target.value)
              }
              aria-label={tab === 'kinfolk' ? 'Filter kinfolk by tag' : 'Filter kin by tag'}
            >
              <option value={TAG_FILTER_ALL}>All tags</option>
              {(tab === 'kinfolk' ? kinfolkTagOptions : kinTagOptions).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <span className="directory__sort-chevron">
              <ChevronGlyph />
            </span>
          </label>
        )}

        <label className="directory__sort">
          <span className="directory__sort-label">Sort</span>
          <select
            className="directory__sort-select"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortOption)}
            aria-label="Sort directory"
          >
            {(tab === 'kinfolk' ? KINFOLK_SORT_OPTIONS : KIN_SORT_OPTIONS).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="directory__sort-chevron">
            <ChevronGlyph />
          </span>
        </label>
      </div>

      {/*
        A broken Kin stream must not silently read as "every household has no
        pets" (the false-empty-on-error class this port refuses to ship). The
        Kinfolk list itself still renders, the failure is disclosed, not
        blocking.
      */}
      {tab === 'kinfolk' && kinState.status === 'error' && (
        <Banner tone="error" title="Couldn't load Kin data">
          Household cards below may be missing kin: {kinState.message}
        </Banner>
      )}

      {tab === 'kinfolk' ? (
        <AsyncRegion
          state={kinfolkState}
          what="kinfolk"
          isEmpty={(rows) => rows.length === 0}
          loading={<LoadingRow label="Loading kinfolk…" className="den-hint" />}
          empty={<EmptyHint>No kinfolk on file yet.</EmptyHint>}
        >
          {(rows) => {
            const visible = filterSortKinfolk(rows, query, sort, activeKinfolkTag);
            if (visible.length === 0) {
              return <EmptyHint>{noMatchHint(query, activeKinfolkTag)}</EmptyHint>;
            }
            return (
              <EntityCardGrid label="Kinfolk" minCardWidth="290px" align="start">
                {visible.map((kf) => (
                  <KinfolkCard
                    key={kf._id}
                    kf={kf}
                    kin={kinByKinfolk.get(kf._id) ?? []}
                    kinPending={kinPending}
                    onClick={() =>
                      onSelectKinfolk
                        ? onSelectKinfolk(kf._id)
                        : void navigate({ to: '/directory/$kinfolkId', params: { kinfolkId: kf._id } })
                    }
                  />
                ))}
              </EntityCardGrid>
            );
          }}
        </AsyncRegion>
      ) : (
        <AsyncRegion
          state={kinState}
          what="kin"
          isEmpty={(rows) => rows.length === 0}
          loading={<LoadingRow label="Loading kin…" className="den-hint" />}
          empty={<EmptyHint>No kin on file yet.</EmptyHint>}
        >
          {(rows) => {
            const visible = filterSortKin(rows, query, sort, activeKinTag);
            if (visible.length === 0) {
              return <EmptyHint>{noMatchHint(query, activeKinTag)}</EmptyHint>;
            }
            return (
              <EntityCardGrid label="Kin" minCardWidth="290px" align="start">
                {visible.map((k) => (
                  <KinCard
                    key={k._id}
                    kin={k}
                    onClick={() => {
                      if (onSelectKin) {
                        onSelectKin(k._id);
                        return;
                      }
                      const household = householdOf(k);
                      setOpenKinId({
                        id: k._id,
                        name: str(k.name),
                        ...(household ? { household } : {}),
                      });
                    }}
                  />
                ))}
              </EntityCardGrid>
            );
          }}
        </AsyncRegion>
      )}

      {showAddKinfolk && (
        <AddKinfolkDialog
          onClose={() => setShowAddKinfolk(false)}
          onCreated={() => {
            setLeftWithoutContactId(null);
            setShowAddKinfolk(false);
          }}
          onLeftWithoutContact={setLeftWithoutContactId}
          operatorUid={auth.status === 'signedIn' ? auth.user.uid : null}
        />
      )}

      {showAddKin && (
        <AddKinDialog
          kinfolkOptions={kinfolkOptions}
          onClose={() => setShowAddKin(false)}
          onCreated={() => setShowAddKin(false)}
        />
      )}
    </div>
  );
}
