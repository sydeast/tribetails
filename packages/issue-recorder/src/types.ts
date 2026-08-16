/**
 * The wire format a walk produces.
 *
 * ONE FORMAT FOR EVERY SURFACE. The dev overlay in the two apps and the
 * bookmarklet that runs against the live sites emit exactly this, so the tool
 * that turns a walk into GitHub issues never has to ask where the walk happened.
 *
 * It is versioned because these files outlive the code that wrote them: a walk
 * exported today may be read weeks later, after the shape has moved on.
 */
export const CAPTURE_FORMAT_VERSION = 1;

/** Where the recorder was running. Decides which repo paths an issue points at. */
export type RecordedApp = 'admin' | 'portal';

/** One console line the app emitted, kept with the moment it happened. */
export interface ConsoleEntry {
  level: 'error' | 'warn';
  /** Milliseconds since the walk started, so it can be lined up with the replay. */
  at: number;
  text: string;
}

/**
 * One network call, with enough of the bodies to see what came back.
 *
 * Callables are the ones that matter here: nearly everything either app renders
 * arrives through one, so "this screen is wrong" is usually "this callable
 * answered something unexpected" and the answer is the evidence.
 */
export interface NetworkEntry {
  at: number;
  method: string;
  url: string;
  /** The callable's name when the URL is one, otherwise null. */
  callable: string | null;
  status: number | null;
  /** Null when the request never completed (aborted, offline, refused). */
  durationMs: number | null;
  /** Truncated. Full bodies would make a walk unreadable and can carry a lot of household data. */
  requestBody: string | null;
  responseBody: string | null;
  error: string | null;
}

/** What the operator was pointing at when they marked the moment. */
export interface MarkedElement {
  /** A CSS path good enough to find it again in a test. */
  selector: string;
  tag: string;
  /** Trimmed visible text, so a mark reads as "the button that says Book" without a screenshot. */
  text: string;
  /** Viewport-relative box, for drawing a ring on the replayed frame. */
  rect: { x: number; y: number; width: number; height: number };
}

/**
 * One "this is wrong", with everything needed to explain why without the
 * operator having written it down.
 */
export interface Mark {
  id: string;
  at: number;
  /** Wall clock, so an issue can say when. */
  isoTime: string;
  route: string;
  fullUrl: string;
  /** Optional and expected to be empty most of the time. Three words beats none, none beats not marking it. */
  note: string;
  element: MarkedElement | null;
  viewport: { width: number; height: number };
  /** Console and network SINCE THE PREVIOUS MARK, not since page load: what was on screen when this went wrong. */
  console: ConsoleEntry[];
  network: NetworkEntry[];
  /** rrweb event index at the moment of the mark, so the replay can seek here. */
  replayIndex: number;
}

export interface SessionMeta {
  id: string;
  formatVersion: number;
  app: RecordedApp;
  /** 'dev' or the live origin, so an issue says which build was walked. */
  origin: string;
  startedIso: string;
  endedIso: string | null;
  userAgent: string;
  /** Signed-in identity when the app exposes one. Never a token, only an email or uid. */
  identity: string | null;
}

export interface CapturedWalk {
  meta: SessionMeta;
  marks: Mark[];
  /** rrweb events. Typed loosely on purpose: this package must not make the consumer depend on rrweb's types. */
  events: unknown[];
}
