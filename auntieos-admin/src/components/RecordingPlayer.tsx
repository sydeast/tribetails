import { useCallback, useEffect, useState } from 'react';
import { getRecordingAudio } from '../api/recordingAudio';
import type { InboxEntry } from '../lib/inboxChannels';
import { LoadingRow } from './LoadingRow';
import { Banner } from './Banner';
import { GhostButton } from './Buttons';
type State =
  | { status: 'loading' }
  | { status: 'ready'; src: string }
  | { status: 'error'; message: string };
/**
 * The Inbox's audio player for a voicemail or a call recording.
 *
 * The stored Twilio link cannot be played directly (it needs the account's
 * credentials, #1573), so the audio is fetched through the `getRecordingAudio`
 * callable when the sheet opens and played from a local object URL. Every wait
 * shows a loading cue, a failure says why and offers a retry, and the object
 * URL is released when the sheet closes.
 */
export function RecordingPlayer({ entry }: { entry: InboxEntry }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const kind = entry.channel === 'voicemail' ? 'voicemail' : 'call';
  useEffect(() => {
    let live = true;
    let objectUrl: string | null = null;
    setState({ status: 'loading' });
    getRecordingAudio(kind, entry.id)
      .then((audio) => {
        if (!live) return;
        if (audio.kind === 'url') {
          setState({ status: 'ready', src: audio.url });
          return;
        }
        objectUrl = URL.createObjectURL(audio.blob);
        setState({ status: 'ready', src: objectUrl });
      })
      .catch((err: unknown) => {
        if (live) setState({ status: 'error', message: err instanceof Error ? err.message : 'Could not load the recording.' });
      });
    return () => {
      live = false;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [kind, entry.id, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const label = `Play the recording from ${entry.kinfolkName !== '' ? entry.kinfolkName : entry.counterpart !== '' ? entry.counterpart : 'this item'}`;
  return (
    <div className="thread-actions__player">
      <p className="thread-actions__player-label">Recording</p>
      {state.status === 'loading' && <LoadingRow label="Loading the recording…" className="thread-actions__player-wait" />}
      {state.status === 'error' && (
        <>
          <Banner tone="error" title="The recording did not load">
            {state.message}
          </Banner>
          <GhostButton label="Try again" onClick={retry} />
        </>
      )}
      {state.status === 'ready' && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio className="thread-actions__audio" controls preload="metadata" src={state.src} aria-label={label} />
      )}
    </div>
  );
}
