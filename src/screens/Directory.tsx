import { useMemo, useState } from 'react';
import {
  KINFOLK_QUERY,
  KIN_QUERY,
  KINFOLK_SORT_OPTIONS,
  KIN_SORT_OPTIONS,
  SORT_OPTION_DEFAULT,
  filterSortKinfolk,
  filterSortKin,
  activeKinByKinfolk,
  kinfolkDisplayName,
  householdSubtitle,
  initialsOf,
  type Kinfolk,
  type Kin,
  type SortOption,
} from '../api/directory';
import { useCollection } from '../lib/firestore';
import { useRovingTabs } from '../lib/useRovingTabs';
import { DenScreenHeading } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { Avatar } from '../components/Avatar';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { AddKinfolkDialog } from '../components/AddKinfolkDialog';
import { AddKinDialog, type KinfolkOption } from '../components/AddKinDialog';
import { KinfolkProfile } from './KinfolkProfile';
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

function statusTone(status: string): string {
  const s = status.toLowerCase();
  if (s === 'active') return 'success';
  if (s === 'inactive') return 'muted';
  if (s === 'archived') return 'warning';
  return 'neutral';
}

/** Screen-local status pill. No shared Pill/Chip primitive exists yet (see the report note). */
function StatusPill({ status }: { status: string }) {
  return (
    <span className="directory__status-pill" data-tone={statusTone(status)}>
      {status.trim() === '' ? '-' : status.toLowerCase()}
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

        <span className="directory__pets">
          {kin.length === 0 ? (
            <span className="directory__pets-empty">
              {kinPending ? 'Loading kin…' : 'No kin on file'}
            </span>
          ) : (
            <>
              {shown.map((k) => (
                <span key={k._id} className="directory__pet-chip">
                  <Avatar
                    label={k.name}
                    glyph={<PawGlyph />}
                    size={22}
                    ring={false}
                    gradientSeed={k._id !== '' ? k._id : k.name}
                  />
                  <span className="directory__pet-chip-label">{k.name}</span>
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
            {kf.phoneNumber !== '' && (
              <span className="directory__card-contact-item">{kf.phoneNumber}</span>
            )}
            {kf.email !== '' && <span className="directory__card-contact-item">{kf.email}</span>}
          </span>
          <StatusPill status={kf.status} />
        </span>
    </>
  );

  // Static, non-interactive card unless a profile handler is wired: a live
  // no-op button is the dead-control anti-pattern (see ControlShell).
  return (
    <li className="directory__cell">
      {onClick ? (
        <button type="button" className="directory__card" onClick={onClick}>
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
  const detail = [kin.species, kin.breed, kin.age !== '' ? `${kin.age} yrs` : '']
    .filter((s) => s !== '')
    .join(' · ');

  const body = (
    <>
        <span className="directory__card-head">
          <Avatar
            label={kin.name}
            imageUrl={kin.profilePictureUrl}
            glyph={<PawGlyph />}
            size={50}
            shape="rounded"
            gradientSeed={kin._id !== '' ? kin._id : kin.name}
          />
          <span className="directory__card-heading">
            <span className="directory__card-name">{kin.name}</span>
            {detail !== '' && <span className="directory__card-sub">{detail}</span>}
          </span>
        </span>

        <span className="directory__card-footer">
          <span className="directory__card-contact">
            {kin.sex !== '' && <span className="directory__card-contact-item">{kin.sex}</span>}
          </span>
          <StatusPill status={kin.status} />
        </span>
    </>
  );

  return (
    <li className="directory__cell">
      {onClick ? (
        <button type="button" className="directory__card" onClick={onClick}>
          {body}
        </button>
      ) : (
        <div className="directory__card directory__card--static">{body}</div>
      )}
    </li>
  );
}

interface DirectoryProps {
  /**
   * Card-open override. Propless (the router default), a kinfolk card now opens
   * the in-screen `KinfolkProfile` detail view. A caller can pass its own handler
   * (a test, or a future route) to take over selection; then the in-screen
   * profile never opens.
   */
  onSelectKinfolk?: (id: string) => void;
  /** Placeholder: KinViewScreen/KinEditScreen don't exist yet in React. Called with a kin id on card-select. */
  onSelectKin?: (id: string) => void;
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
export function Directory({ onSelectKinfolk, onSelectKin }: DirectoryProps) {
  const kinfolkState = useCollection<Kinfolk>(KINFOLK_QUERY);
  const kinState = useCollection<Kin>(KIN_QUERY);

  const [tab, setTab] = useState<DirectoryTab>('kinfolk');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortOption>(SORT_OPTION_DEFAULT);
  // The household profile detail view: a sibling VIEW of this list (the Inbox /
  // Communicate pattern), opened when a card is activated and no external
  // onSelectKinfolk overrides. Holds the id; the profile reads the full doc.
  const [openKinfolkId, setOpenKinfolkId] = useState<string | null>(null);

  // Roving-tabindex keyboard nav for the Kinfolk/Kin tablist below
  // (Left/Right, Home/End, roving tabIndex).
  const { getTabProps } = useRovingTabs({ count: 2, activeIndex: tab === 'kinfolk' ? 0 : 1 });

  // The two DEFERRED create flows (this screen was read-only until now).
  // Both dialogs close themselves on success; neither manually refetches,
  // KINFOLK_QUERY / KIN_QUERY are live onSnapshot streams (useCollection), so
  // the new row appears in the grid the instant the write lands.
  const [showAddKinfolk, setShowAddKinfolk] = useState(false);
  const [showAddKin, setShowAddKin] = useState(false);

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
        onBack={() => setOpenKinfolkId(null)}
      />
    );
  }

  return (
    <div className="screen">
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
            <GhostButton label="Add kin" onClick={() => setShowAddKin(true)} leading={<PlusGlyph />} />
          </div>
        }
      />

      <div className="directory__controls">
        <div className="directory__tabs" role="tablist" aria-label="Directory view">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'kinfolk'}
            className="directory__tab"
            onClick={() => selectTab('kinfolk')}
            {...getTabProps(0)}
          >
            Kinfolk{kinfolkCount !== null ? ` · ${kinfolkCount}` : ''}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'kin'}
            className="directory__tab"
            onClick={() => selectTab('kin')}
            {...getTabProps(1)}
          >
            Kin{kinCount !== null ? ` · ${kinCount}` : ''}
          </button>
        </div>

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
        </label>
      </div>

      {/*
        A broken Kin stream must not silently read as "every household has no
        pets" (the false-empty-on-error class this port refuses to ship). The
        Kinfolk list itself still renders, the failure is disclosed, not
        blocking.
      */}
      {tab === 'kinfolk' && kinState.status === 'error' && (
        <Banner tone="error" title="Couldn't load pet data">
          Household cards below may be missing kin: {kinState.message}
        </Banner>
      )}

      {tab === 'kinfolk' ? (
        <AsyncRegion
          state={kinfolkState}
          what="kinfolk"
          isEmpty={(rows) => rows.length === 0}
          loading={<p className="directory__hint">Loading kinfolk…</p>}
          empty={<p className="directory__hint">No kinfolk on file yet.</p>}
        >
          {(rows) => {
            const visible = filterSortKinfolk(rows, query, sort);
            if (visible.length === 0) {
              return <p className="directory__hint">No matches for &ldquo;{query}&rdquo;.</p>;
            }
            return (
              <ul className="directory__grid">
                {visible.map((kf) => (
                  <KinfolkCard
                    key={kf._id}
                    kf={kf}
                    kin={kinByKinfolk.get(kf._id) ?? []}
                    kinPending={kinPending}
                    onClick={() => (onSelectKinfolk ? onSelectKinfolk(kf._id) : setOpenKinfolkId(kf._id))}
                  />
                ))}
              </ul>
            );
          }}
        </AsyncRegion>
      ) : (
        <AsyncRegion
          state={kinState}
          what="kin"
          isEmpty={(rows) => rows.length === 0}
          loading={<p className="directory__hint">Loading kin…</p>}
          empty={<p className="directory__hint">No kin on file yet.</p>}
        >
          {(rows) => {
            const visible = filterSortKin(rows, query, sort);
            if (visible.length === 0) {
              return <p className="directory__hint">No matches for &ldquo;{query}&rdquo;.</p>;
            }
            return (
              <ul className="directory__grid">
                {visible.map((k) => (
                  <KinCard
                    key={k._id}
                    kin={k}
                    {...(onSelectKin ? { onClick: () => onSelectKin(k._id) } : {})}
                  />
                ))}
              </ul>
            );
          }}
        </AsyncRegion>
      )}

      {showAddKinfolk && (
        <AddKinfolkDialog
          onClose={() => setShowAddKinfolk(false)}
          onCreated={() => setShowAddKinfolk(false)}
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
