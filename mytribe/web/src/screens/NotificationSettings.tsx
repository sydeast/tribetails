import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CHANNEL_ORDER,
  categoryChannels,
  categoryMarketingCategories,
  categoryMasterState,
  categoryToggleableChannels,
  channelChecked,
  getMyNotificationPrefs,
  getNotificationCatalog,
  keyChannelChecked,
  keyChannelOverridden,
  keyLockedChannels,
  keyDescription,
  keyTitle,
  marketingMasterState,
  saveMyNotificationPrefs,
  type CategoryDto,
  type Channel,
  type GetMyNotificationPrefsResult,
  type MarketingCategory,
  type MasterState,
  type NotificationPrefsPatch,
  type NotificationKeyDto,
  type UserNotificationPrefs,
} from '../api/notificationsApi';
import { useSignOut } from '../lib/auth';
import { PortalNav } from '../components/PortalNav';
import { LaunchError } from './LaunchError';
import { OfflineNotice } from '../components/OfflineNotice';
import { viewOfQuery } from '../lib/queryState';
import { OfflineMutationNotice } from '../components/OfflineMutationNotice';
import { errorLine, usePortalMutation } from '../lib/mutationState';
import { refreshAfterSave } from '../lib/refreshAfterSave';
import '../styles/notifications.css';
import { SettingsBusinessFootnote } from '../components/BusinessFootnote';

/**
 * Notification Settings, ported from
 * ui-ideas/mytribe-notifications-2026-05-31.html. Despite the filename this
 * is a PREFERENCES screen (category master switches + per-channel toggles),
 * not a notification feed — there's no feed/inbox callable in this codebase.
 *
 * Data: getNotificationCatalog (functions/src/notifications/
 * getNotificationCatalog.ts) supplies categories, each with one or more
 * notification keys carrying their own allowedChannels/lockedChannels.
 * getMyNotificationPrefs/saveMyNotificationPrefs (functions/src/portal/
 * notificationPrefs.ts) read/write the byCategory/byKey/marketingOptIn
 * shape at clients/{uid}.notificationPrefs — uid-scoped, no kinfolkId.
 *
 * Category row vs. per-key rows: the mockup renders one row per CHANNEL
 * within a category card (Push / Email / SMS), and that row writes
 * byCategory and is "the category default", not "every key in it": the
 * dispatcher still force-enables an always-on key's locked channel
 * regardless of this screen's write (categoryToggleableChannels in
 * notificationsApi.ts covers the cross-key aggregation for that row).
 *
 * P7 (per-key notification toggles): the mockup's own filename,
 * "justNeedsExpansionForEachSectionForGranularModification", is the spec
 * for the second layer this screen now renders inside each expanded card:
 * one row per notification key per channel, matching Compose's expand panel
 * (NotificationSettingsScreen.kt). A key channel row writes byKey[key][ch]
 * only when the kinfolk touches it; an untouched key has no byKey entry at
 * all and inherits the category row's value, so byKey never gets
 * materialized for keys nobody chose to override (see keyChannelChecked /
 * keyChannelOverridden in notificationsApi.ts, and their tests, for the
 * exact inheritance rule). A channel in a key's own lockedChannels renders
 * read-only regardless of any byKey/byCategory write, showing the catalog's
 * lockReason when there is one.
 *
 * Marketing category: the mockup's two channel rows ("Marketing email" /
 * "Marketing SMS") are permanently disabled decorative rows in the static
 * markup — the mockup's own script explicitly skips disabled checkboxes, so
 * nothing ever wires them live. The category's master switch is the only
 * interactive control, and it maps straight to marketingOptIn (CAN-SPAM /
 * CASL opt-in-by-default-off) rather than byCategory.
 *
 * "Schedule Reminders": the catalog's `schedule` category title/description
 * ("Upcoming Care" / a scheduling blurb) is relabeled client-side to match
 * the mockup's framing, mirroring NotificationSettingsScreen.kt's documented
 * D12 relabel (catalog id/key untouched, prefs still write the same).
 */

/**
 * THE ONE SENTENCE FOR A CHANNEL THE HOUSEHOLD CANNOT CHANGE (#451).
 *
 * This screen used to say "Always on. Required by Tribe Tails." on the category
 * rows while the per-key rows already said this. "Always on" is a promise this
 * screen has no standing to make: the catalog's `alwaysEnabled` flag is
 * advisory (ruling #7, 2026-06-08, warn-but-allow-off — `resolveChannels` has
 * no alwaysEnabled check), so Tribe Tails can switch the notification off at any
 * time and it will genuinely stop sending. The static fallback catalog the
 * Android portal falls back to when `getNotificationCatalog` fails does not even
 * know the operator's current gate, so "always" there is a guess printed as a
 * fact.
 *
 * What IS true at this layer, and all this sentence claims: the household is not
 * the one who decides this channel, and this screen is not where it changes.
 */
export const SET_BY_BUSINESS_NOTE = 'Set by Tribe Tails Pet Care. Can’t be changed here.';
const CATEGORY_ICON: Record<string, string> = {
  visit: '\u{1F43E}', // paw
  kintale: '\u{1F4DD}', // memo
  invoice: '\u{1F4B3}', // card
  marketing: '\u{1F4E2}', // megaphone
  schedule: '⏰', // alarm clock
  home: '\u{1F3E0}', // house
  account: '\u{1F464}', // person
};
const CATEGORY_ICON_FALLBACK = '\u{1F514}'; // bell

const CATEGORY_COLOR_CLASS: Record<string, string> = {
  visit: 'cat-vu',
  kintale: 'cat-kt',
  invoice: 'cat-bi',
  marketing: 'cat-mk',
  schedule: 'cat-vu',
  home: 'cat-bi',
  account: 'cat-mk',
};
const CATEGORY_COLOR_CYCLE = ['cat-vu', 'cat-kt', 'cat-bi', 'cat-mk'];

/**
 * The mockup's two-column layout only ever showed 5 categories (visit,
 * kintale, invoice in the main column; marketing, schedule in the aside).
 * The live catalog also returns `home` and `account` kinfolk-facing
 * categories the mockup never depicted. Rather than hardcode a 5-category
 * assumption, every category renders using this same card design; only
 * `marketing` and `schedule` — the two the mockup places in the narrower
 * aside column — go there. Anything else (including future categories)
 * flows into the main column, preserving catalog order.
 */
const ASIDE_CATEGORY_IDS = new Set(['marketing', 'schedule']);

const CHANNEL_ROW_COPY: Partial<Record<string, Partial<Record<Channel, { icon: string; label: string; desc: string }>>>> = {
  visit: {
    push: { icon: '\u{1F4F1}', label: 'Push', desc: 'Live alerts on your phone the moment a visit starts or ends.' },
    email: { icon: '✉️', label: 'Email', desc: 'A recap in your inbox after every completed visit.' },
    sms: { icon: '\u{1F4AC}', label: 'SMS', desc: 'Text messages for time sensitive visit updates.' },
  },
  kintale: {
    push: { icon: '\u{1F4F1}', label: 'Push', desc: 'A nudge when a new KinTale is ready to read.' },
    email: { icon: '✉️', label: 'Email', desc: 'The full KinTale with photos delivered to your inbox.' },
    sms: { icon: '\u{1F4AC}', label: 'SMS', desc: 'A short text linking you to the new tale.' },
  },
  invoice: {
    push: { icon: '\u{1F4F1}', label: 'Push', desc: 'A heads up when a new invoice posts or a payment is due.' },
    email: { icon: '✉️', label: 'Email', desc: 'Invoices and receipts sent to your inbox.' },
    sms: { icon: '\u{1F4AC}', label: 'SMS', desc: 'A text reminder before a payment is due.' },
  },
  schedule: {
    push: { icon: '\u{1F4F1}', label: 'Push', desc: 'A reminder the day before a booked visit.' },
    email: { icon: '✉️', label: 'Email', desc: 'A weekly look ahead at your scheduled visits.' },
  },
};

const GENERIC_CHANNEL_COPY: Record<Channel, { icon: string; label: string; desc: string }> = {
  push: { icon: '\u{1F4F1}', label: 'Push', desc: 'Real-time alerts on your phone.' },
  email: { icon: '✉️', label: 'Email', desc: 'Sent to your inbox.' },
  sms: { icon: '\u{1F4AC}', label: 'SMS', desc: 'Text message alerts.' },
};

const MARKETING_ROW_LABEL: Record<Channel, string> = {
  push: 'Marketing push',
  email: 'Marketing email',
  sms: 'Marketing SMS',
};

function channelCopy(catId: string, ch: Channel) {
  return CHANNEL_ROW_COPY[catId]?.[ch] ?? GENERIC_CHANNEL_COPY[ch];
}

function categoryIcon(id: string): string {
  return CATEGORY_ICON[id] ?? CATEGORY_ICON_FALLBACK;
}

function categoryColorClass(id: string, index: number): string {
  return CATEGORY_COLOR_CLASS[id] ?? CATEGORY_COLOR_CYCLE[index % CATEGORY_COLOR_CYCLE.length] ?? 'cat-vu';
}

function displayTitle(cat: CategoryDto): string {
  return cat.id === 'schedule' ? 'Schedule Reminders' : cat.title;
}

function displayDescription(cat: CategoryDto): string {
  return cat.id === 'schedule' ? 'Reminders before upcoming and pending visits on your calendar.' : cat.description;
}

type ByCategoryState = Record<string, Partial<Record<Channel, boolean>>>;
type MarketingOptInState = Partial<Record<MarketingCategory, boolean>>;

interface EditedPrefs {
  byCategory: ByCategoryState;
  // Always an object, never undefined. In memory an empty map and an absent
  // one meant the same thing, but on the wire they did not: web omitted
  // `byKey` where Compose sent `{}`, the one place the two clients disagreed.
  // The state now carries the shape the payload has.
  byKey: NonNullable<UserNotificationPrefs['byKey']>;
  marketingOptIn: MarketingOptInState;
}

function seedEdited(source: UserNotificationPrefs): EditedPrefs {
  const byCategory: ByCategoryState = {};
  for (const [catId, channels] of Object.entries(source.byCategory ?? {})) {
    if (channels) byCategory[catId] = { ...channels };
  }
  return {
    byCategory,
    byKey: { ...(source.byKey ?? {}) },
    marketingOptIn: { ...(source.marketingOptIn ?? {}) },
  };
}
/**
 * A switch that can read ON, OFF or MIXED. The browser's `indeterminate` flag
 * is a DOM property with no attribute, so it is set from an effect.
 */
function MasterSwitch({ state, label, disabled, onChange }: { state: MasterState; label: string; disabled: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'mixed';
  }, [state]);
  return (
    <label className="sw">
      <input
        ref={ref}
        type="checkbox"
        aria-label={label}
        aria-checked={state === 'mixed' ? 'mixed' : state === 'on'}
        checked={state === 'on'}
        disabled={disabled}
        onChange={onChange}
      />
      <span className="slot" />
      <span className="knob" />
    </label>
  );
}
export function NotificationSettings() {
  const queryClient = useQueryClient();

  const catalog = useQuery({ queryKey: ['notificationCatalog'], queryFn: getNotificationCatalog });
  const prefs = useQuery({ queryKey: ['myNotificationPrefs'], queryFn: getMyNotificationPrefs });

  const [edited, setEdited] = useState<EditedPrefs | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showSaved, setShowSaved] = useState(false);
  // Seed local state once from the server. After that it only changes when a
  // save is confirmed (see `save` below), so what is on screen is what the
  // server holds, never a guess.
  useEffect(() => {
    if (edited !== null || !prefs.data) return;
    setEdited(seedEdited(prefs.data.prefs));
  }, [edited, prefs.data]);
  // #1292: every toggle saves on its own, pessimistically. Nothing on screen
  // changes until the server confirms, every control is disabled and a
  // "Saving…" cue shows while the write is out, and a failure leaves the
  // switch where it was with a message. 'abandon' because a toggle taken
  // offline is refused with "nothing was sent" rather than held and replayed
  // minutes later against a screen the household has moved on from.
  //
  // The write is a PATCH naming only what the tap changed; the server merges it
  // into the stored prefs. The old whole-object save rebuilt the subtree from
  // this screen's state and deleted whatever another device had written.
  const save = usePortalMutation({
    mutationFn: (patch: NotificationPrefsPatch) => saveMyNotificationPrefs(patch),
    // Settled either way: re-read the server and show THAT. On success it is the
    // change just made; on a failure (or a lost signal, where we cannot know)
    // it is whatever is really stored.
    onSettled: async () => {
      await refreshAfterSave(queryClient, ['myNotificationPrefs']);
      const fresh = queryClient.getQueryData<GetMyNotificationPrefsResult>(['myNotificationPrefs']);
      if (fresh) setEdited(seedEdited(fresh.prefs));
    },
    onSuccess: () => {
      setShowSaved(true);
      setTimeout(() => setShowSaved(false), 4000);
    },
  }, { policy: 'abandon', what: 'this change' });
  const busy = save.isPending;
  const { signOut, signingOut } = useSignOut();

  if (catalog.isError || prefs.isError) {
    return (
      <LaunchError
        onRetry={() => {
          void catalog.refetch();
          void prefs.refetch();
        }}
        retrying={catalog.isRefetching || prefs.isRefetching}
        onSignOut={signOut} signingOut={signingOut}
      />
    );
  }

  // `edited` is seeded from prefs in an effect, so while a read is paused it
  // stays null and `loading` stays true forever: a settings page that spins
  // with no reason given. The offline arm below is rendered in its place.
  const catalogView = viewOfQuery(catalog);
  const prefsView = viewOfQuery(prefs);
  const offline = catalogView.kind === 'offline' || prefsView.kind === 'offline';
  const loading = !offline && (catalog.isLoading || prefs.isLoading || edited === null);
  const categories = catalog.data?.categories ?? [];
  const mainCategories = categories.filter((c) => !ASIDE_CATEGORY_IDS.has(c.id));
  const asideCategories = categories.filter((c) => ASIDE_CATEGORY_IDS.has(c.id));

  function toggleChannelRow(cat: CategoryDto, ch: Channel) {
    if (!edited || busy || !categoryToggleableChannels(cat).includes(ch)) return;
    const current = channelChecked(cat, ch, edited.byCategory[cat.id]);
    setShowSaved(false);
    save.mutate({ byCategory: { [cat.id]: { [ch]: !current } } });
  }
  function toggleCategoryMaster(cat: CategoryDto) {
    if (!edited || busy) return;
    setShowSaved(false);
    if (cat.id === 'marketing') {
      // Mixed turns everything on, the usual answer to a click on a mixed switch.
      const next = marketingMasterState(cat, edited.marketingOptIn) !== 'on';
      const marketingOptIn: Partial<Record<MarketingCategory, boolean>> = {};
      for (const mc of categoryMarketingCategories(cat)) marketingOptIn[mc] = next;
      save.mutate({ marketingOptIn });
      return;
    }
    const toggleable = categoryToggleableChannels(cat);
    if (toggleable.length === 0) return;
    const next = categoryMasterState(cat, edited.byCategory[cat.id]) !== 'on';
    const channels: Partial<Record<Channel, boolean>> = {};
    for (const ch of toggleable) channels[ch] = next;
    save.mutate({ byCategory: { [cat.id]: channels } });
  }
  // Task 27a model: byKey is an override, absence means inherit. So a
  // key-channel has three honest states — on, off, or inheriting — and a
  // kinfolk must be able to get back to inheriting. Rather than add a
  // separate "follow the category" control, the existing toggle does double
  // duty: if the value the kinfolk just chose is the SAME value the key
  // would have inherited anyway, the override is cleared (sent as null)
  // instead of pinned. Only byKey[key][ch] is named in the patch; the
  // category's byCategory entry and every other key's entry are not in it.
  function toggleKeyChannel(cat: CategoryDto, key: NotificationKeyDto, ch: Channel) {
    if (!edited || busy || keyLockedChannels(key).includes(ch)) return;
    const current = keyChannelChecked(key, ch, edited.byKey[key.key], edited.byCategory[cat.id]);
    const next = !current;
    const inherited = keyChannelChecked(key, ch, undefined, edited.byCategory[cat.id]);
    setShowSaved(false);
    save.mutate({ byKey: { [key.key]: { [ch]: next === inherited ? null : next } } });
  }
  function renderCard(cat: CategoryDto, index: number) {
    const isExpanded = expanded[cat.id] ?? true;
    const isMarketing = cat.id === 'marketing';
    const rows = categoryChannels(cat);
    const masterState: MasterState = isMarketing
      ? marketingMasterState(cat, edited?.marketingOptIn)
      : categoryMasterState(cat, edited?.byCategory[cat.id]);

    return (
      <section className={`glass card d${(index % 4) + 1}`} key={cat.id}>
        <div className={`cathead ${categoryColorClass(cat.id, index)}`}>
          <div className="ico">{categoryIcon(cat.id)}</div>
          <div className="ht">
            <h3 className="title">
              {displayTitle(cat)}
              {cat.id === 'schedule' && (
                <span className="nf-sugtag" title="Suggested reminders for upcoming visits. Change any of them below.">
                  Suggestion
                </span>
              )}
            </h3>
            <div className="sub">{displayDescription(cat)}</div>
          </div>
        </div>

        <div className="catbar">
          <div className="master">
            <span className="lbl">All in category:</span>
            {/* Task 27a defect #2: byKey always wins over byCategory, so this
                switch only moves keys with no choice of their own. That used to
                be a paragraph under the panel; it is a tooltip now (operator
                ruling 2026-09-11: no explanatory copy under panel titles). */}
            {!isMarketing && cat.keys.length > 0 && (
              <span className="nf-tip">
                <button type="button" className="nf-tip-btn" aria-label="About this switch" aria-describedby={`nf-tip-${cat.id}`}>
                  i
                </button>
                <span role="tooltip" id={`nf-tip-${cat.id}`} className="nf-tip-text">
                  Keys below with their own channel choice won&rsquo;t change when you flip this.
                </span>
              </span>
            )}
            <MasterSwitch
              state={masterState}
              label={`All in category: ${displayTitle(cat)}`}
              disabled={busy}
              onChange={() => toggleCategoryMaster(cat)}
            />
          </div>
          <div className="exg" role="group" aria-label="Expand or collapse channels">
            <button type="button" aria-pressed={isExpanded} onClick={() => setExpanded((prev) => ({ ...prev, [cat.id]: true }))}>
              Expand
            </button>
            <button type="button" aria-pressed={!isExpanded} onClick={() => setExpanded((prev) => ({ ...prev, [cat.id]: false }))}>
              Collapse
            </button>
          </div>
        </div>

        <div className={`chans ${isExpanded ? '' : 'collapsed'}`}>
          <div className="inner">
            {isMarketing
              ? rows.map((ch) => (
                  <div className="crow off" key={ch}>
                    <div className="cico">{channelCopy(cat.id, ch).icon}</div>
                    <div className="cinfo">
                      <b>{MARKETING_ROW_LABEL[ch]}</b>
                      <small>Enable the parent marketing opt-in above to receive this.</small>
                    </div>
                    <label className="sw dis">
                      <input type="checkbox" checked={false} disabled readOnly />
                      <span className="slot" />
                      <span className="knob" />
                    </label>
                  </div>
                ))
              : rows.map((ch) => {
                  const copy = channelCopy(cat.id, ch);
                  const checked = channelChecked(cat, ch, edited?.byCategory[cat.id]);
                  const locked = !categoryToggleableChannels(cat).includes(ch);
                  return (
                    <div className={`crow ${checked ? '' : 'off'}`} key={ch}>
                      <div className="cico">{copy.icon}</div>
                      <div className="cinfo">
                        <b>{copy.label}</b>
                        <small>{locked ? SET_BY_BUSINESS_NOTE : copy.desc}</small>
                      </div>
                      <label className={`sw ${locked ? 'dis' : ''}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={locked || busy}
                          onChange={() => toggleChannelRow(cat, ch)}
                        />
                        <span className="slot" />
                        <span className="knob" />
                      </label>
                    </div>
                  );
                })}
            {!isMarketing && cat.keys.length > 0 && (
              <div className="nf-keys">
                {cat.keys.map((k) => (
                  <div className="nf-key" key={k.key}>
                    <div className="nf-key-head">
                      <b>{keyTitle(k)}</b>
                      {keyDescription(k) && <small>{keyDescription(k)}</small>}
                    </div>
                    <div className="nf-key-chans">
                      {k.allowedChannels
                        .filter((ch) => CHANNEL_ORDER.includes(ch))
                        .sort((a, b) => CHANNEL_ORDER.indexOf(a) - CHANNEL_ORDER.indexOf(b))
                        .map((ch) => {
                          const copy = channelCopy(cat.id, ch);
                          const locked = keyLockedChannels(k).includes(ch);
                          const checked = keyChannelChecked(k, ch, edited?.byKey?.[k.key], edited?.byCategory[cat.id]);
                          const overridden = keyChannelOverridden(edited?.byKey?.[k.key], ch);
                          return (
                            <div className="nf-key-crow" key={ch}>
                              <label className={`sw ${locked ? 'dis' : ''}`}>
                                <input
                                  type="checkbox"
                                  aria-label={`${copy.label} for ${keyTitle(k)}`}
                                  checked={checked}
                                  disabled={locked || busy}
                                  onChange={() => toggleKeyChannel(cat, k, ch)}
                                />
                                <span className="slot" />
                                <span className="knob" />
                              </label>
                              <div className="nf-key-chinfo">
                                <b>{copy.label}</b>
                                {locked ? (
                                  <small>{k.lockReason?.trim() || SET_BY_BUSINESS_NOTE}</small>
                                ) : (
                                  <span className={`nf-key-badge ${overridden ? 'overridden' : 'following'}`}>
                                    {overridden ? 'Overridden' : 'Following category'}
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {isMarketing && (
          <>
            <p className="nf-helper">Enable the parent marketing opt-in above to receive this.</p>
            <p className="nf-helper">Every marketing email includes an unsubscribe link.</p>
            <div className="disnote">
              <span className="di">{'\u{1F512}'}</span>
              <p>These channels stay off until the category master switch is on. Turning it off again opts you out everywhere.</p>
            </div>
          </>
        )}
      </section>
    );
  }

  return (
    <>
      <PortalNav active="account" />

      <div className="wrap">
        <header className="hero-greet">
          <div className="kick">Account</div>
          <h1>
            Notification <span>Settings</span>
          </h1>
        </header>

        {offline ? (
          <section className="glass card">
            <OfflineNotice what="your notification preferences" />
          </section>
        ) : loading ? (
          <p className="sub">Loading your notification preferences&hellip;</p>
        ) : (
          <>
            <div className="cols">
              <div className="stack">{mainCategories.map((c, i) => renderCard(c, i))}</div>
              <div className="stack">{asideCategories.map((c, i) => renderCard(c, mainCategories.length + i))}</div>
            </div>

            <div className="savebar" role="status" aria-live="polite">
              {busy && (
                <span className="nf-saving">
                  <span className="loading-spinner loading-spinner--inline" aria-hidden="true" />
                  Saving your change…
                </span>
              )}
              <span className={`savedchip ${showSaved && !busy ? 'show' : ''}`}>{'✓'} Saved.</span>
              {save.phase === 'failed' && !busy && (
                <span className="sub" style={{ color: 'var(--coral)' }} role="alert">
                  {errorLine(save, 'Couldn’t save that change.')} The switch is back where it was.
                </span>
              )}
              <OfflineMutationNotice phase={save.phase} what="this change" check="this page" />
              <span className="savehint">Each change saves as soon as you make it.</span>
            </div>
          </>
        )}

        <SettingsBusinessFootnote />
      </div>
    </>
  );
}
