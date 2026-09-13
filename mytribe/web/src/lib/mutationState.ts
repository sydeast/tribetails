import { useEffect, useRef } from 'react';
import { onlineManager, useMutation } from '@tanstack/react-query';
import type { UseMutationOptions, UseMutationResult } from '@tanstack/react-query';

/**
 * What a portal control should say while a WRITE is in flight, and what it is
 * allowed to promise about a write that never left the phone.
 *
 * THE DEFECT THIS EXISTS FOR (#807). `lib/queryClient.ts` leaves `networkMode`
 * at its default 'online', which governs MUTATIONS as well as reads. A mutation
 * started with no connection does not fail, it PAUSES:
 *
 *   retryer.js       canFetch(networkMode) -> onlineManager.isOnline()
 *   mutation.js:87   const isPaused = !retryer.canStart()
 *
 * A paused mutation never settles, so `isPending` stays true and `isError`
 * stays false forever. Every button here renders its busy label off
 * `isPending`, so a household who taps Save in a dead zone sits on "Saving…"
 * with no way to tell "still working" from "never left your phone". #805 fixed
 * exactly this shape on the READ side; this is its twin for writes.
 *
 * IT IS NOT ONE FIX, BECAUSE A PAUSE IS NOT ONE BEHAVIOUR. A paused mutation
 * fires itself the moment the signal returns, unattended, minutes later. For
 * `saveMyAccount` that is the best outcome available: the household typed
 * something, meant it, and gets it. For `payInvoice` the same mechanism walks
 * a phone that has been put back in a pocket to a Stripe checkout page, and
 * the second tap that a stuck spinner invites can settle a bill twice (see the
 * payment findings below). So the policy is PER ACTION and is declared at the
 * call site, where somebody editing that screen will read it.
 *
 *   'hold'     Keep the pause. The write sends itself on reconnect, and the
 *              screen says so: "Waiting for signal". Earned by a write that is
 *              safe to arrive late and safe to arrive twice — an overwrite, a
 *              flag, or a server-side guard that refuses the second attempt.
 *   'abandon'  Refuse before dialling. The write is dropped with a message and
 *              the household re-taps deliberately when they have signal. For a
 *              write that CREATES, that charges, or whose success handler
 *              navigates somewhere the household is no longer looking at.
 *
 * THE DECISION TABLE. Each verdict is a claim about the SERVER, established by
 * reading the callable, never by assuming — the same bar `lib/fns.ts` sets for
 * its `idempotent` opt-in.
 *
 *   payInvoice                    ABANDON, and this is the one the issue asked
 *     Invoices, InvoiceDetail     to establish rather than assume. Both halves
 *                                 of the answer, because they differ:
 *
 *                                 THE SERVER NOW HAS A BACKSTOP (issue #826;
 *                                 this paragraph used to say it had none, and
 *                                 that is what #826 was filed on). The callable
 *                                 still charges nothing itself and still
 *                                 creates a Checkout Session per call, each
 *                                 with its own PaymentIntent, so a second
 *                                 session still sails past both
 *                                 `stripeEvents/{event.id}` and
 *                                 `stripePayments/{paymentIntentId}`. What
 *                                 changed is a THIRD ledger in `stripeWebhook`
 *                                 that compares a settling session against the
 *                                 invoice's own settlement round: two completed
 *                                 checkouts for one balance no longer pay the
 *                                 bill twice — the second lands in the
 *                                 household's account balance and raises a
 *                                 critical audit. `payInvoice` also hands back
 *                                 an open session rather than minting a second.
 *                                 See functions/src/lib/invoiceCheckoutDedupe.ts.
 *
 *                                 THE CLIENT STILL CANNOT REACH IT. Success is
 *                                 `window.location.href = checkoutUrl`, which
 *                                 unloads the page, so a second session cannot
 *                                 be opened from one page life. That is no
 *                                 longer the ONLY thing holding it shut, which
 *                                 is the whole point of the change.
 *
 *                                 ABANDON is chosen for the redirect, which is
 *                                 live today: a held mutation resumes minutes
 *                                 later and walks a pocketed phone to a
 *                                 payment page nobody asked it to open.
 *   createBillingSetupSession     ABANDON. `mode: 'setup'`, so it charges
 *     Account                     nothing and a duplicate session is harmless
 *                                 money-wise. Abandoned anyway for the
 *                                 navigation: this one also redirects out of
 *                                 the app on success.
 *   redeemCredit                  HOLD. The guard, the balance increment and
 *     Invoices, InvoiceDetail     the `creditRedeemedAt` stamp are one
 *                                 Firestore transaction, so a second redeem
 *                                 re-reads the committed stamp and fails with
 *                                 'Credit already redeemed.' It cannot
 *                                 double-credit.
 *   removeMyPaymentMethod         HOLD. Answers `alreadyEmpty: true` the
 *     Account                     second time and touches no invoice, charge
 *                                 or ledger.
 *   acceptQuote / denyQuote       HOLD. One transaction, refusing an already
 *     InvoiceDetail               decided quote with `quote_already_decided`.
 *   requestBooking                HOLD, and this one is the exception worth
 *     BookingWizard               reading twice. It is a CREATE, which #819
 *                                 treated as a blanket reason to offer nothing
 *                                 — but it carries an `idempotencyKey` minted
 *                                 ONCE per submission and held in a ref across
 *                                 attempts (`BookingWizard#keyForSubmission`),
 *                                 and the envelope at
 *                                 `families/{id}/bookings/{batchId}` IS the
 *                                 dedupe record. A re-send of the same
 *                                 submission is the same booking.
 *
 * The remaining verdicts live beside their call sites. The rule they follow:
 * a create with no key abandons, an overwrite or a guarded write holds.
 *
 * TWO THINGS ABOUT 'hold' THAT A CALL SITE HAS TO KNOW.
 *
 * A HELD WRITE RESUMES WHETHER OR NOT ITS SCREEN IS STILL THERE. The options
 * `onSuccess` lives on the Mutation, not on the observer, so it runs on
 * reconnect even after the component unmounted. `invalidateQueries` is exactly
 * right there and a `setStatus` is a harmless no-op, but anything that
 * NAVIGATES has to be guarded by a mounted ref, or a household reading their
 * KinTales gets thrown onto Schedule by a booking they submitted twenty
 * minutes ago (`BookingWizard`, which does exactly that, guards it).
 *
 * AND A HELD WRITE CANNOT BE CANCELLED. `reset()` detaches the observer; the
 * Mutation still resumes. It also lives in memory and not on disk, so closing
 * the tab loses it. The copy says "leave this page open" for that reason and
 * not as a politeness.
 *
 * WHY A PER-MUTATION `networkMode` HONOURS #805 RATHER THAN CONTRADICTING IT.
 * #805 refused to flip the flag GLOBALLY, and its reason was about reads: every
 * screen's query-error path is `LaunchError`, whose second button signs the
 * household out and clears the cache they can still read, so turning a dropped
 * bar into an error would hand a stranded household that button. No mutation
 * here routes to `LaunchError`. Their error paths are inline sentences beside
 * the control that failed (`mutationErrorMessage` on Invoices, `setStatus` on
 * Account), which is a place an offline message can be told honestly. Reads are
 * untouched by this file and still pause.
 */

/** How a write behaves when the phone has no connection. */
export type MutationPolicy = 'hold' | 'abandon';

/**
 * Thrown by the preflight on an 'abandon' write, BEFORE the request is dialled.
 *
 * It exists so the screen can say the one thing that matters and is otherwise
 * unknowable: nothing was sent. `functions/internal` is what the Firebase SDK
 * reports for every transport failure, and it covers both "never arrived" and
 * "committed, and the reply was lost" (see `lib/fns.ts`). A screen cannot tell
 * those apart from the error alone, so it must not claim to — only a refusal
 * raised on this side of the wire proves the request never happened.
 */
export class OfflineMutationError extends Error {
  constructor(what: string) {
    super(`You are offline, so ${what} was not sent.`);
    this.name = 'OfflineMutationError';
  }
}

/**
 * Thrown in place of the transport error when the signal went AFTER the request
 * was already away.
 *
 * The class is the latch, and it has to be one. A phase computed from a live
 * `isOnline()` reading would change under the household's feet: the write fails
 * offline and reads "we can't tell whether this reached us", then the signal
 * comes back, the same error re-renders against a true `isOnline()`, and the
 * sentence becomes "Couldn't open checkout. Try again." — which is a re-tap
 * invitation delivered at the exact moment they are able to act on it, about a
 * payment that may already have gone through. What was true when the request
 * died stays true.
 */
export class LostSignalError extends Error {
  constructor(what: string, options?: { cause?: unknown }) {
    super(`Your signal went while ${what} was sending.`, options);
    this.name = 'LostSignalError';
  }
}

/**
 * What a write is doing, as one word.
 *
 * 'unknown' is the member that earns this type. A request that was already away
 * when the signal dropped may have landed; saying "nothing was sent" there
 * would be the same class of confident lie about an unknown that #805 removed
 * from the read side.
 */
export type MutationPhase =
  | 'idle'
  | 'sending'
  /** Paused offline under 'hold'. React Query sends it on reconnect. */
  | 'queued'
  /** Refused before dialling under 'abandon'. Nothing was sent. */
  | 'blocked'
  /** Dialled, then the signal went. Whether it landed is not knowable here. */
  | 'unknown'
  /** The server answered, badly. Not an offline state; the screen owns it. */
  | 'failed';

/** The part of a mutation result this module reads. Structural, so the decision is testable without React. */
export type MutationSnapshot = Pick<
  UseMutationResult<unknown, unknown, unknown, unknown>,
  'isPending' | 'isPaused' | 'isError' | 'error'
>;

/**
 * Decide what a control should say. Pure — a function of the mutation alone.
 *
 * `isPaused` is read before `isPending` because a paused mutation reports BOTH,
 * and treating it as 'sending' is the whole defect. The two offline errors are
 * told apart by CLASS rather than by asking whether the phone is online now:
 * see `LostSignalError` for why the answer has to be latched at the failure.
 */
export function phaseOfMutation(m: MutationSnapshot): MutationPhase {
  if (m.isPending) return m.isPaused ? 'queued' : 'sending';
  if (m.isError) {
    if (m.error instanceof OfflineMutationError) return 'blocked';
    if (m.error instanceof LostSignalError) return 'unknown';
    return 'failed';
  }
  return 'idle';
}

/** True while the write is in the household's hands rather than the server's. */
export function isOfflinePhase(phase: MutationPhase): boolean {
  return phase === 'queued' || phase === 'blocked' || phase === 'unknown';
}

/**
 * Is this one of the two offline failures, rather than an answer from a server?
 *
 * For an `onError` handler, which sees the error and not the mutation.
 * `errorLine` covers the screens that render off `isError` at paint; the ones
 * that push a sentence into state as it happens need the same rule, and
 * without it they say "Save failed" over a write whose outcome is unknown.
 * "Failed" is exactly the claim this whole change exists to stop making.
 */
export function isOfflineError(err: unknown): boolean {
  return err instanceof OfflineMutationError || err instanceof LostSignalError;
}

/**
 * Does this phone have a connection, by both readings?
 *
 * BOTH, because each misses a case the other catches. `onlineManager` starts
 * `true` and only an `online`/`offline` event moves it, so a PWA cold-loaded
 * from the service worker cache with no signal sails through an
 * onlineManager-only check. And `navigator.onLine` alone would let the
 * preflight disagree with the thing that actually decides whether React Query
 * pauses, which is how a screen ends up saying "waiting for signal" over a
 * request that is running.
 */
export function isConnected(): boolean {
  if (!onlineManager.isOnline()) return false;
  if (typeof navigator === 'undefined') return true;
  // A BOOLEAN, not truthiness: `navigator` exists in more places than
  // `navigator.onLine` does — Node 21+ defines the global with no `onLine` on
  // it at all — and `undefined` is falsy, so a bare read reports "offline"
  // everywhere this runs outside a browser. Absent means unknown, and unknown
  // has to mean online: the refusal this gates is the one thing in the app
  // that can PROVE nothing was sent, and it must never fire on a guess.
  return typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
}


/**
 * Is the screen that started this write still on screen?
 *
 * For the one thing a 'hold' site must not do blind. The options `onSuccess`
 * lives on the Mutation rather than the observer, so it runs when a held write
 * resumes even though the component is long gone — and a `navigate()` in there
 * yanks a household out of whatever they are reading, twenty minutes after the
 * tap, with no way to connect the two. Invalidating a cache from a dead screen
 * is fine and wanted. Moving somebody is not.
 */
export function useIsMounted(): () => boolean {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return () => mounted.current;
}

/**
 * The red line a screen shows under a failed write, or null.
 *
 * Every offline phase already renders `OfflineMutationNotice`, which says
 * something truer and calmer than "Couldn't open checkout. Try again." Two
 * sentences about one failure, one of them wrong, is worse than either alone,
 * so the rule lives here instead of being re-derived at twenty call sites.
 */
export function errorLine(m: MutationSnapshot, fallback: string): string | null {
  if (phaseOfMutation(m) !== 'failed') return null;
  return m.error instanceof Error && m.error.message ? m.error.message : fallback;
}

export interface PortalMutationOptions {
  /**
   * Whether a paused write is held for resume or abandoned. See the header:
   * this is a claim about the callable, and a wrong one double-writes.
   */
  policy: MutationPolicy;
  /**
   * What is being written, lower-case, for the message: "so your changes were
   * not sent". Reads as the object of a sentence, not as a screen name.
   */
  what: string;
}

export interface PortalMutationExtras {
  phase: MutationPhase;
  policy: MutationPolicy;
  what: string;
}

/**
 * `useMutation` with the offline behaviour decided rather than inherited.
 *
 * One wrapper rather than an edit per call site, for the reason #819 gave for
 * `LoadingLine`: the property that must hold everywhere is that no write can
 * stall silently, and a property that is re-implemented per screen is one a
 * screen can forget. The call site declares the policy and the noun; this
 * arranges the rest.
 *
 * 'abandon' gets BOTH halves and needs both. `networkMode: 'always'` stops the
 * pause, and the preflight stops the doomed round-trip that would otherwise
 * replace it — without the preflight an abandoned write reaches `onError` with
 * `functions/internal`, which is exactly the ambiguous code that cannot tell a
 * household whether their money moved.
 */
export function usePortalMutation<TData, TError, TVars, TContext>(
  options: UseMutationOptions<TData, TError, TVars, TContext> & { mutationFn: (vars: TVars) => Promise<TData> },
  { policy, what }: PortalMutationOptions,
): UseMutationResult<TData, TError, TVars, TContext> & PortalMutationExtras {
  const { mutationFn, ...rest } = options;
  const result = useMutation<TData, TError, TVars, TContext>({
    ...rest,
    ...(policy === 'abandon' ? { networkMode: 'always' as const } : {}),
    mutationFn: async (vars: TVars) => {
      if (policy === 'abandon' && !isConnected()) throw new OfflineMutationError(what);
      try {
        return await mutationFn(vars);
      } catch (err) {
        // The signal went between the preflight and the answer. Relabel HERE,
        // at the one moment the truth is knowable, rather than leaving the
        // screen to ask a question whose answer changes on reconnect.
        if (!isConnected()) throw new LostSignalError(what, { cause: err });
        throw err;
      }
    },
  });
  return {
    ...result,
    phase: phaseOfMutation(result),
    policy,
    what,
  };
}
