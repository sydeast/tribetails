// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InboxEntry } from '../lib/inboxChannels';
const { getRecordingAudio } = vi.hoisted(() => ({ getRecordingAudio: vi.fn() }));
vi.mock('../api/recordingAudio', () => ({ getRecordingAudio }));
import { RecordingPlayer } from './RecordingPlayer';
function entry(over: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id: 'vm1',
    channel: 'voicemail',
    timestamp: '2026-07-20T14:00:00.000Z',
    kinfolkName: '',
    counterpart: '+15551234567',
    preview: '',
    direction: 'inbound',
    statusHint: 'unread',
    mediaCount: 0,
    replyPhone: '+15551234567',
    replyEmail: '',
    kinfolkId: '',
    playbackUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1',
    voicemailId: 'vm1',
    ...over,
  };
}
const created: string[] = [];
const revoked: string[] = [];
beforeEach(() => {
  getRecordingAudio.mockReset();
  created.length = 0;
  revoked.length = 0;
  let n = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => {
      const u = `blob:test/${++n}`;
      created.push(u);
      return u;
    }),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn((u: string) => revoked.push(u)),
  });
});
afterEach(() => vi.restoreAllMocks());
describe('RecordingPlayer', () => {
  it('shows a loading cue, then plays the audio the server returned, never the Twilio link', async () => {
    let resolve!: (v: unknown) => void;
    getRecordingAudio.mockReturnValue(new Promise((r) => (resolve = r)));
    const { container } = render(<RecordingPlayer entry={entry()} />);
    expect(screen.getByText('Loading the recording…')).toBeInTheDocument();
    expect(container.querySelector('audio')).toBeNull();
    resolve({ kind: 'blob', blob: new Blob(['x'], { type: 'audio/mpeg' }) });
    await waitFor(() => expect(container.querySelector('audio')).not.toBeNull());
    expect(container.querySelector('audio')).toHaveAttribute('src', created[0]);
    expect(container.innerHTML).not.toContain('api.twilio.com');
    expect(getRecordingAudio).toHaveBeenCalledWith('voicemail', 'vm1');
  });
  it('asks for a call recording by its call id', async () => {
    getRecordingAudio.mockResolvedValue({ kind: 'url', url: 'https://example.test/c.mp3' });
    render(<RecordingPlayer entry={entry({ id: 'c9', channel: 'call', voicemailId: '' })} />);
    await waitFor(() => expect(getRecordingAudio).toHaveBeenCalledWith('call', 'c9'));
  });
  it('says why it failed and retries on request', async () => {
    getRecordingAudio.mockRejectedValueOnce(new Error('Twilio no longer has this recording.'));
    getRecordingAudio.mockResolvedValueOnce({ kind: 'blob', blob: new Blob(['x']) });
    const { container } = render(<RecordingPlayer entry={entry()} />);
    expect(await screen.findByText('Twilio no longer has this recording.')).toBeInTheDocument();
    expect(container.querySelector('audio')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(container.querySelector('audio')).not.toBeNull());
    expect(getRecordingAudio).toHaveBeenCalledTimes(2);
  });
  it('releases the object URL when the sheet closes', async () => {
    getRecordingAudio.mockResolvedValue({ kind: 'blob', blob: new Blob(['x']) });
    const { container, unmount } = render(<RecordingPlayer entry={entry()} />);
    await waitFor(() => expect(container.querySelector('audio')).not.toBeNull());
    unmount();
    expect(revoked).toEqual(created);
  });
});
