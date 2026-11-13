import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getTemplateChannels,
  saveTemplateChannels,
  wordingErrorsFrom,
  type TemplateChannels,
  type WordingErrors,
  type WordingField,
} from '../api/templateChannels';
import {
  SAVE_TEMPLATE_FIRST,
  addChannelLabel,
  channelSavedNotice,
  channelUnavailableReason,
  characterCount,
  localWordingError,
  saveChannelLabel,
  smsSegmentHint,
  type WordingChannel,
} from '../lib/templateChannelFormat';
import { GhostButton, PrimaryButton } from './Buttons';
import { Banner } from './Banner';
import { DenPanel, StatusPill } from './DenScreenKit';
import { useToast } from './Toast';

export interface TemplateChannelPanelsProps {
  /** The stored template, or null while a new one has not been saved yet. */
  templateId: string | null;
  /** Which of the two is on screen. The other stays mounted so a draft survives a tab switch. */
  active: WordingChannel;
}

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; channels: TemplateChannels };

interface Draft {
  smsText: string;
  pushTitle: string;
  pushBody: string;
}

const draftOf = (c: TemplateChannels): Draft => ({
  smsText: c.sms.text,
  pushTitle: c.push.title,
  pushBody: c.push.body,
});

/** What each field is called on screen, and in the sentences about it. */
const FIELD_LABEL: Readonly<Record<WordingField, string>> = {
  smsText: 'Text message',
  pushTitle: 'Title',
  pushBody: 'Message',
};

const FIELDS_OF: Readonly<Record<WordingChannel, readonly WordingField[]>> = {
  sms: ['smsText'],
  push: ['pushTitle', 'pushBody'],
};

/**
 * #1935: the Text message and Push notification tabs of the template editor.
 *
 * Mounted the first time either tab is opened, and it loads once for both, so
 * opening a template to fix its email costs no extra read. Each channel saves
 * on its own button and sends only itself: a text that fails a rule can never
 * hold up a push edit, and neither touches the email form beside it.
 *
 * A channel reads one of three ways, decided by the server: wording to edit;
 * "Not set" with a button to add it, when the notification sends that channel
 * and nobody has written it; or "Not set" with the reason and no button, when
 * nothing would ever send it.
 */
export function TemplateChannelPanels({ templateId, active }: TemplateChannelPanelsProps) {
  const { showToast } = useToast();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<Draft>({ smsText: '', pushTitle: '', pushBody: '' });
  const [adding, setAdding] = useState<Record<WordingChannel, boolean>>({ sms: false, push: false });
  const [saving, setSaving] = useState<WordingChannel | null>(null);
  const [fieldErrors, setFieldErrors] = useState<WordingErrors>({});
  const [saveError, setSaveError] = useState<Partial<Record<WordingChannel, string>>>({});
  const inputs = useRef<Partial<Record<WordingField, HTMLInputElement | HTMLTextAreaElement | null>>>({});
  // The field a chip drops its {{name}} into: the last one the operator was in.
  const lastFocused = useRef<WordingField | null>(null);
  const pendingCaret = useRef<{ field: WordingField; at: number } | null>(null);

  useEffect(() => {
    if (templateId === null) return;
    let live = true;
    setLoad({ status: 'loading' });
    getTemplateChannels(templateId).then(
      (channels) => {
        if (!live) return;
        setLoad({ status: 'ready', channels });
        setDraft(draftOf(channels));
      },
      (err: unknown) => {
        if (live) setLoad({ status: 'error', message: err instanceof Error ? err.message : 'Could not load.' });
      },
    );
    return () => {
      live = false;
    };
  }, [templateId, attempt]);

  useEffect(() => {
    const pending = pendingCaret.current;
    if (!pending) return;
    pendingCaret.current = null;
    const el = inputs.current[pending.field];
    if (!el) return;
    el.focus();
    el.setSelectionRange(pending.at, pending.at);
  }, [draft]);

  const setField = useCallback((field: WordingField, value: string) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
    // Typing is the answer to the message beside the field.
    setFieldErrors((prev) => {
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
    setSaveError({});
  }, []);

  function insertField(channel: WordingChannel, name: string) {
    const candidates = FIELDS_OF[channel];
    const focused = lastFocused.current && candidates.includes(lastFocused.current) ? lastFocused.current : null;
    const field = focused ?? candidates[candidates.length - 1]!;
    const token = `{{${name}}}`;
    const el = inputs.current[field];
    const current = draft[field];
    // A box the operator has never been in has no caret worth reading (a
    // browser reports 0), so the field goes on the end of it.
    const start = focused ? (el?.selectionStart ?? current.length) : current.length;
    const end = focused ? (el?.selectionEnd ?? start) : start;
    pendingCaret.current = { field, at: start + token.length };
    setField(field, current.slice(0, start) + token + current.slice(end));
  }

  async function save(channel: WordingChannel, channels: TemplateChannels) {
    if (saving !== null || templateId === null) return;
    const limits: Record<WordingField, number> = {
      smsText: channels.sms.maxLength,
      pushTitle: channels.push.titleMaxLength,
      pushBody: channels.push.bodyMaxLength,
    };
    const found: WordingErrors = {};
    for (const field of FIELDS_OF[channel]) {
      const problem = localWordingError(FIELD_LABEL[field], draft[field], limits[field]);
      if (problem) found[field] = problem;
    }
    if (Object.keys(found).length > 0) {
      setFieldErrors((prev) => ({ ...prev, ...found }));
      return;
    }
    setSaving(channel);
    setSaveError({});
    try {
      const next = await saveTemplateChannels(
        channel === 'sms'
          ? { templateId, sms: { text: draft.smsText } }
          : { templateId, push: { title: draft.pushTitle, body: draft.pushBody } },
      );
      // Only the saved channel's boxes take the server's copy: a draft sitting
      // in the other tab is not thrown away by this save.
      setLoad({ status: 'ready', channels: next });
      setDraft((prev) =>
        channel === 'sms'
          ? { ...prev, smsText: next.sms.text }
          : { ...prev, pushTitle: next.push.title, pushBody: next.push.body },
      );
      setAdding((prev) => ({ ...prev, [channel]: false }));
      showToast(channelSavedNotice(channel));
    } catch (err) {
      const refused = wordingErrorsFrom(err);
      if (refused && Object.keys(refused).length > 0) {
        setFieldErrors((prev) => ({ ...prev, ...refused }));
      } else {
        setSaveError({ [channel]: err instanceof Error ? err.message : 'Save failed.' });
      }
    } finally {
      setSaving(null);
    }
  }

  function field(name: WordingField, channel: WordingChannel, max: number, multiline: boolean) {
    const id = `template-channel-${name}`;
    const error = fieldErrors[name];
    const shared = {
      id,
      value: draft[name],
      disabled: saving === channel,
      'aria-invalid': error ? (true as const) : undefined,
      'aria-describedby': error ? `${id}-error ${id}-count` : `${id}-count`,
      onFocus: () => {
        lastFocused.current = name;
      },
    };
    return (
      <div className="template-editor__field" key={name}>
        <span className="template-editor__labelrow">
          <label className="template-editor__label" htmlFor={id}>
            {FIELD_LABEL[name]}
          </label>
          <span className="template-editor__req" aria-hidden="true">
            *
          </span>
        </span>
        {multiline ? (
          <textarea
            {...shared}
            ref={(el) => {
              inputs.current[name] = el;
            }}
            className="template-editor__textarea"
            rows={name === 'smsText' ? 6 : 3}
            onChange={(e) => setField(name, e.target.value)}
          />
        ) : (
          <input
            {...shared}
            ref={(el) => {
              inputs.current[name] = el;
            }}
            type="text"
            className="template-editor__input"
            onChange={(e) => setField(name, e.target.value)}
          />
        )}
        {error ? (
          <p id={`${id}-error`} className="template-editor__field-error" role="alert">
            {error}
          </p>
        ) : null}
        <p id={`${id}-count`} className="template-editor__hint">
          {characterCount(draft[name], max)}
        </p>
        {name === 'smsText' && smsSegmentHint(draft.smsText) ? (
          <p className="template-editor__hint" data-testid="template-channel-sms-segments">
            {smsSegmentHint(draft.smsText)}
          </p>
        ) : null}
      </div>
    );
  }

  function notSet(channel: WordingChannel, reason: string | null, onAdd?: () => void) {
    return (
      <div className="template-editor__notset" data-testid={`template-channel-${channel}-notset`}>
        <StatusPill tone="warning" label="Not set" />
        {reason ? <p className="template-editor__hint">{reason}</p> : null}
        {onAdd ? <GhostButton label={addChannelLabel(channel)} onClick={onAdd} /> : null}
      </div>
    );
  }

  function body(channel: WordingChannel) {
    if (templateId === null) return notSet(channel, SAVE_TEMPLATE_FIRST);
    if (load.status === 'loading') {
      return (
        <p className="template-editor__hint template-editor__loading" role="status" aria-live="polite">
          <span className="template-editor__spinner" aria-hidden="true" />
          Loading…
        </p>
      );
    }
    if (load.status === 'error') {
      return (
        <Banner
          tone="error"
          title="Couldn&rsquo;t load"
          trailing={<GhostButton label="Try again" onClick={() => setAttempt((n) => n + 1)} />}
        >
          {load.message}
        </Banner>
      );
    }
    const { channels } = load;
    const state = channels[channel];
    if (!state.supported) {
      return notSet(channel, channelUnavailableReason(channel, channels.notificationLabel));
    }
    // Half-written push wording (a title and no message) is not "set" for the
    // sender, but it is there to read and finish, so it opens the form. Same
    // reading on Android and desktop.
    const hasWording =
      channel === 'sms'
        ? channels.sms.set
        : channels.push.set || channels.push.title.trim() !== '' || channels.push.body.trim() !== '';
    if (!hasWording && !adding[channel]) {
      return notSet(channel, null, () => setAdding((prev) => ({ ...prev, [channel]: true })));
    }
    const failure = saveError[channel];
    return (
      <div className="template-editor__fields">
        {channel === 'sms' ? (
          field('smsText', 'sms', channels.sms.maxLength, true)
        ) : (
          <>
            {field('pushTitle', 'push', channels.push.titleMaxLength, false)}
            {field('pushBody', 'push', channels.push.bodyMaxLength, true)}
          </>
        )}
        {channels.fields.length > 0 ? (
          <div className="template-editor__field">
            <span className="template-editor__label" id={`template-channel-${channel}-fields`}>
              Fields you can use
            </span>
            <div
              className="template-editor__chips"
              role="group"
              aria-labelledby={`template-channel-${channel}-fields`}
            >
              {channels.fields.map((name) => (
                <button
                  key={name}
                  type="button"
                  className="template-editor__chip"
                  disabled={saving === channel}
                  // Swallowed so the box keeps its caret through the click.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertField(channel, name)}
                >
                  <span className="template-editor__chip-plus" aria-hidden="true">
                    +
                  </span>
                  {`{{${name}}}`}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {failure ? (
          <p className="template-editor__field-error" role="alert">
            {failure}
          </p>
        ) : null}
        <div className="template-editor__channel-actions">
          <PrimaryButton
            label={saving === channel ? 'Saving…' : saveChannelLabel(channel)}
            onClick={() => void save(channel, channels)}
            disabled={saving !== null}
            busy={saving === channel}
          />
        </div>
      </div>
    );
  }

  return (
    <>
      {(['sms', 'push'] as const).map((channel) => (
        <div
          key={channel}
          id={`template-channel-panel-${channel}`}
          role="tabpanel"
          aria-labelledby={`template-channel-tab-${channel}`}
          hidden={active !== channel}
          data-channel={channel}
        >
          {/* No title of its own, like the email panel: the page heading and
              the open tab already name the channel. */}
          <DenPanel title="" className="template-editor__panel">
            {body(channel)}
          </DenPanel>
        </div>
      ))}
    </>
  );
}
