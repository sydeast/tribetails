/**
 * #1049: masks every phone-shaped run of digits in a sentence, so a message can
 * go into `activity_log` without carrying a phone number. A run of 7 or more
 * digits (spaces, dots, dashes and parentheses allowed between them, and a
 * leading `+` or `(`) becomes `…` plus its last four digits, the same `…0143` form
 * `scripts/reportMultipleEmergencyContacts.ts#maskPhone` prints. Shorter
 * numbers ("80 characters", "one") are left alone.
 */
const PHONE_RUN = /\+?\(?\d[\d\s().-]*\d/g;

export function maskPhoneDigits(text: string): string {
  return text.replace(PHONE_RUN, (run) => {
    const digits = run.replace(/\D/g, '');
    return digits.length >= 7 ? `…${digits.slice(-4)}` : run;
  });
}
