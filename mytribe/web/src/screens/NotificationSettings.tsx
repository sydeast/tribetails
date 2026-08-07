import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CHANNEL_ORDER,
  categoryChannels,
  categoryMarketingCategories,
  categoryMasterChecked,
  categoryToggleableChannels,
  channelChecked,
  getMyNotificationPrefs,
  getNotificationCatalog,
  keyChannelChecked,
  keyChannelOverridden,
  keyLockedChannels,
  marketingMasterChecked,
  saveMyNotificationPrefs,
  type CategoryDto,
  type Channel,
  type MarketingCategory,
  type NotificationKeyDto,
  type UserNotificationPrefs,
} from '../api/notificationsApi';
import { useSignOut } from '../lib/auth';
import { PortalNav } from '../components/PortalNav';
import { LaunchError } from './LaunchError';
import '../styles/notifications.css';

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
  byKey: UserNotificationPrefs['byKey'] | undefined;
  marketingOptIn: MarketingOptInState;
}

export function NotificationSettings() {
  const queryClient = useQueryClient();

  const catalog = useQuery({ queryKey: ['notificationCatalog'], queryFn: getNotificationCatalog });
  const prefs = useQuery({ queryKey: ['myNotificationPrefs'], queryFn: getMyNotificationPrefs });

  const [edited, setEdited] = useState<EditedPrefs | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showSaved, setShowSaved] = useState(false);

  // Seed local edit state once from the server; local edits then diverge
  // from the cache until Save (matches KinDetail/Kin's read-then-mutate
  // pattern — server refetches after a save don't clobber in-flight edits).
  useEffect(() => {
    if (edited !== null || !prefs.data) return;
    const source = prefs.data.prefs;
    const byCategory: ByCategoryState = {};
    for (const [catId, channels] of Object.entries(source.byCategory ?? {})) {
      if (channels) byCategory[catId] = { ...channels };
    }
    setEdited({
      byCategory,
      byKey: source.byKey,
      marketingOptIn: { ...(source.marketingOptIn ?? {}) },
    });
  }, [edited, prefs.data]);

  const save = useMutation({
    mutationFn: () => {
      if (!edited) return Promise.reject(new Error('Preferences not loaded yet.'));
      const toSave: UserNotificationPrefs = {
        byCategory: edited.byCategory,
        marketingOptIn: edited.marketingOptIn,
        ...(edited.byKey !== undefined ? { byKey: edited.byKey } : {}),
      };
      return saveMyNotificationPrefs(toSave);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['myNotificationPrefs'] });
      setShowSaved(true);
      setTimeout(() => setShowSaved(false), 4000);
    },
  });

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

  const loading = catalog.isLoading || prefs.isLoading || edited === null;
  const categories = catalog.data?.categories ?? [];
  const mainCategories = categories.filter((c) => !ASIDE_CATEGORY_IDS.has(c.id));
  const asideCategories = categories.filter((c) => ASIDE_CATEGORY_IDS.has(c.id));

  function toggleChannelRow(cat: CategoryDto, ch: Channel) {
    if (!edited || !categoryToggleableChannels(cat).includes(ch)) return;
    const current = channelChecked(cat, ch, edited.byCategory[cat.id]);
    setEdited({
      ...edited,
      byCategory: { ...edited.byCategory, [cat.id]: { ...(edited.byCategory[cat.id] ?? {}), [ch]: !current } },
    });
  }

  function toggleCategoryMaster(cat: CategoryDto) {
    if (!edited) return;
    if (cat.id === 'marketing') {
      const next = !marketingMasterChecked(cat, edited.marketingOptIn);
      const marketingOptIn = { ...edited.marketingOptIn };
      for (const mc of categoryMarketingCategories(cat)) marketingOptIn[mc] = next;
      setEdited({ ...edited, marketingOptIn });
      return;
    }
    const toggleable = categoryToggleableChannels(cat);
    if (toggleable.length === 0) return;
    const next = !categoryMasterChecked(cat, edited.byCategory[cat.id]);
    const updated = { ...(edited.byCategory[cat.id] ?? {}) };
    for (const ch of toggleable) updated[ch] = next;
    setEdited({ ...edited, byCategory: { ...edited.byCategory, [cat.id]: updated } });
  }

  // Writes byKey[key.key][ch] only; the category's byCategory entry (and
  // every other key's byKey entry) is left untouched. A key nobody has
  // toggled never gets a byKey entry at all: this is the only place byKey
  // gets written, and it only fires from a deliberate click here.
  function toggleKeyChannel(cat: CategoryDto, key: NotificationKeyDto, ch: Channel) {
    if (!edited || keyLockedChannels(key).includes(ch)) return;
    const current = keyChannelChecked(key, ch, edited.byKey?.[key.key], edited.byCategory[cat.id]);
    setEdited({
      ...edited,
      byKey: {
        ...(edited.byKey ?? {}),
        [key.key]: { ...(edited.byKey?.[key.key] ?? {}), [ch]: !current },
      },
    });
  }

  function renderCard(cat: CategoryDto, index: number) {
    const isExpanded = expanded[cat.id] ?? true;
    const isMarketing = cat.id === 'marketing';
    const rows = categoryChannels(cat);
    const masterChecked = isMarketing
      ? marketingMasterChecked(cat, edited?.marketingOptIn)
      : categoryMasterChecked(cat, edited?.byCategory[cat.id]);

    return (
      <section className={`glass card d${(index % 4) + 1}`} key={cat.id}>
        <div className={`cathead ${categoryColorClass(cat.id, index)}`}>
          <div className="ico">{categoryIcon(cat.id)}</div>
          <div className="ht">
            <h3 className="title">
              {displayTitle(cat)}
              {cat.id === 'schedule' && <span className="nf-sugtag">Suggestion</span>}
            </h3>
            <div className="sub">{displayDescription(cat)}</div>
          </div>
        </div>

        <div className="catbar">
          <div className="master">
            <span className="lbl">All in category:</span>
            <label className="sw">
              <input type="checkbox" checked={masterChecked} onChange={() => toggleCategoryMaster(cat)} />
              <span className="slot" />
              <span className="knob" />
            </label>
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
                    <div className="cico">{ch === 'email' ? '\u{1F4E7}' : '\u{1F4AC}'}</div>
                    <div className="cinfo">
                      <b>{ch === 'email' ? 'Marketing email' : 'Marketing SMS'}</b>
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
                        <small>{locked ? 'Always on. Required by Tribe Tails.' : copy.desc}</small>
                      </div>
                      <label className={`sw ${locked ? 'dis' : ''}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={locked}
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
                      <b>{k.title}</b>
                      <small>{k.description}</small>
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
                                  aria-label={`${copy.label} for ${k.title}`}
                                  checked={checked}
                                  disabled={locked}
                                  onChange={() => toggleKeyChannel(cat, k, ch)}
                                />
                                <span className="slot" />
                                <span className="knob" />
                              </label>
                              <div className="nf-key-chinfo">
                                <b>{copy.label}</b>
                                {locked ? (
                                  <small>{k.lockReason?.trim() || 'Set by Tribe Tails Pet Care. Can’t be changed here.'}</small>
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

        {loading ? (
          <p className="sub">Loading your notification preferences&hellip;</p>
        ) : (
          <>
            <div className="cols">
              <div className="stack">{mainCategories.map((c, i) => renderCard(c, i))}</div>
              <div className="stack">{asideCategories.map((c, i) => renderCard(c, mainCategories.length + i))}</div>
            </div>

            <div className="savebar">
              <button type="button" className="btn grad" onClick={() => save.mutate()} disabled={save.isPending}>
                {'\u{1F4BE}'} {save.isPending ? 'Saving…' : 'Save Notification Preferences'}
              </button>
              <span className={`savedchip ${showSaved ? 'show' : ''}`}>{'✓'} Preferences saved.</span>
              {save.isError && !showSaved && (
                <span className="sub" style={{ color: 'var(--coral)' }}>
                  Couldn&rsquo;t save. Try again.
                </span>
              )}
              <span className="savehint">Changes apply across MyTribe push, email, and SMS.</span>
            </div>
          </>
        )}

        <p className="footnote">
          Cared for by <b>Tribe Tails Pet Care</b>
        </p>
      </div>
    </>
  );
}
