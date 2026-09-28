# Staff accounts

Minting and revoking the Owner and Auntie roles. The rulings are D-2026-09-22-AUNTIE-ROLE and O-6 in `docs/DECISIONS.md`.

Moved out of `docs/RUNBOOK.md` on 2026-09-28 so the runbook holds only the release procedure. The text is the runbook's, with cross-references repointed at the new files.

## Adding a new employee

There are two staff roles since #944 (operator ruling 2026-09-22, spec in
`docs/superpowers/specs/2026-09-22-admin-auntie-access-design.md`). Pick the
right one before minting anything; they are separate claims and an account must
never hold both.

| Role | Claim | Sees | Minted with |
|---|---|---|---|
| Owner | `admin: true` | Everything | `setAdminClaim` (from an owner account), or `mytribe/functions/scripts/grant-admin-claim.mjs` |
| Auntie (caretaker, contractor or employee) | `staffRole: "auntie"` | Households, kin, visits, 411s, their own schedule. Never money, dossiers or the household bank | `mytribe/functions/scripts/grant-staff-role.mjs` |

**Hiring an Auntie.** Run once per hire, from `mytribe/functions`:

```bash
GOOGLE_CLOUD_PROJECT=auntieos-ttpc node scripts/grant-staff-role.mjs \
  --email auntie@example.com --role auntie
```

Add `--password` only when the account does not exist yet. `--role none`
revokes it. Do **not** give an Auntie the `admin` claim: 116 rule sites and 62
server expressions read `admin`, and the split is safe only because an Auntie
carries none of it. `grant-staff-role.mjs` refuses to mint both, and
`setAdminClaim` refuses to grant `admin` to an account that holds `staffRole`.

**Adding an owner. Mint the `admin` custom claim. Adding the uid to
`AUNTIE_OPERATOR_UIDS` is not enough, and it is not the same thing.**

RULING O-6 makes the `admin` custom claim the primary staff signal. The env
allowlist is a **logged transition fallback**, kept only until every real
operator's claim is confirmed minted, and then decommissioned. `isOwner`
(`mytribe/functions/src/lib/staffGate.ts`, called `isStaff` before #944) is the
single gate every owner check goes through, and when it matches on the
allowlist without a claim it warns:

```
admin.allowlist.fallback.used
  AUNTIE_OPERATOR_UIDS env-allowlist path matched; admin custom claim missing.
```

**That log line is the detector.** If it fires for a uid, that employee is
running on the fallback and someone skipped this step. It is a `warn`, so it
does not fail anything and will sit there indefinitely.

Why it matters beyond tidiness: **Firestore and Storage rules do not consult the
env allowlist at all.** `isOwner()` in `mytribe/firestore.rules` reads
`request.auth.token.admin == true`, the claim. So an allowlist-only employee
passes every *callable* and is refused by every *rule*, which means the
callable-backed screens work while direct reads fail. That split is confusing to
diagnose from the symptom, because most of the app looks fine.

The claim also has to be minted before that employee can hold more than one
tribe, per the 2026-08-07 ruling that only an admin may be assigned several.
`kinfolkClaim.ts` refuses to designate a household for a multi-tribe account, and
recovery is a tribe-picker selection, which is the operator flow.

**On offboarding**, revoke the claim (`--role none` for an Auntie). Removing the uid from the env allowlist
alone leaves the claim minted, and the claim is the one the rules trust.
