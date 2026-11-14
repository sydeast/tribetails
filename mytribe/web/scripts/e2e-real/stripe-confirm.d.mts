/** Types for `stripe-confirm.mjs`, so `cypress.real.config.ts` can import it under `tsc -p cypress`. */
export interface ConfirmCheckoutInput {
  sessionId: string;
  amountCents: number;
  email: string;
  name: string;
}

export const CONFIRM_STEPS: string[];
export function redact(text: unknown, literals?: unknown[]): string;
export function confirmFixture(input: ConfirmCheckoutInput): Record<string, unknown>;
export function confirmCheckoutByCli(
  input: ConfirmCheckoutInput,
  options?: { env?: Record<string, string | undefined>; spawn?: (...args: never[]) => unknown },
): string[];
