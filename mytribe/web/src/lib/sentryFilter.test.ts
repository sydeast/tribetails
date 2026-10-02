import type { ErrorEvent } from '@sentry/react';
import { describe, expect, it } from 'vitest';
import { dropRecaptchaNoise, isRecaptchaNoise } from './sentryFilter';
const RECAPTCHA = 'https://www.gstatic.com/recaptcha/releases/abc123/recaptcha__en.js';
const GOOGLE_RECAPTCHA = 'https://www.google.com/recaptcha/enterprise/anchor';
function eventWithFrames(...filenames: Array<string | undefined>): ErrorEvent {
  return {
    type: undefined,
    exception: {
      values: [
        {
          type: 'TypeError',
          value: "Cannot read properties of undefined (reading 'h6')",
          stacktrace: { frames: filenames.map((filename) => (filename ? { filename } : {})) },
        },
      ],
    },
  };
}
describe('dropRecaptchaNoise', () => {
  it('drops an event whose frames are all gstatic reCAPTCHA', () => {
    expect(dropRecaptchaNoise(eventWithFrames(RECAPTCHA, RECAPTCHA))).toBeNull();
  });
  it('drops an event whose frames mix gstatic and google.com reCAPTCHA', () => {
    expect(dropRecaptchaNoise(eventWithFrames(RECAPTCHA, GOOGLE_RECAPTCHA))).toBeNull();
  });
  it('ignores frames that name no file when judging', () => {
    expect(dropRecaptchaNoise(eventWithFrames(RECAPTCHA, undefined, '<anonymous>'))).toBeNull();
  });
  it('keeps an event with a first-party frame among reCAPTCHA frames', () => {
    const event = eventWithFrames(RECAPTCHA, 'https://kinfolk.tribetails.com/assets/index-1a2b.js');
    expect(dropRecaptchaNoise(event)).toBe(event);
  });
  it('keeps an event with only first-party frames', () => {
    const event = eventWithFrames('https://kinfolk.tribetails.com/assets/index-1a2b.js');
    expect(dropRecaptchaNoise(event)).toBe(event);
  });
  it('keeps an event with no frames and an ordinary message', () => {
    const event: ErrorEvent = { type: undefined, message: 'Network request failed' };
    expect(dropRecaptchaNoise(event)).toBe(event);
  });
  it('does not treat a look-alike host as reCAPTCHA', () => {
    const event = eventWithFrames('https://evil-gstatic.com.example.org/recaptcha/x.js');
    expect(dropRecaptchaNoise(event)).toBe(event);
  });
  it('drops the forwarded "[web] Uncaught ... recaptcha__" message form', () => {
    const event: ErrorEvent = {
      type: undefined,
      message:
        "[web] Uncaught TypeError: Cannot read properties of undefined (reading 'h6') (https://www.gstatic.com/recaptcha/releases/abc123/recaptcha__en.js:811:196)",
    };
    expect(dropRecaptchaNoise(event)).toBeNull();
  });
  it('keeps a "[web]" message that does not point at reCAPTCHA', () => {
    const event: ErrorEvent = {
      type: undefined,
      message: '[web] Uncaught TypeError: x is undefined (https://kinfolk.tribetails.com/app.js:1:1)',
    };
    expect(isRecaptchaNoise(event)).toBe(false);
  });
});
