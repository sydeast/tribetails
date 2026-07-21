"""Firebase Cloud Function (2nd gen, Python) — nightly reconcile worker + on-demand synthesis.

Scheduled function:
  nightly_reconcile — triggered by Cloud Scheduler at 03:00 America/Chicago.
  Runs reconcile_pass() against all comm collections + kin_care_reports,
  marking each as applied or error.  Read-only on existing dossier/the_411
  fields except where the pipeline explicitly merges new content.

On-demand callable:
  synthesize_kinfolk_profile — admin-gated HTTPS callable that triggers profile
  and dossier synthesis for a single kinfolk on demand.  Reuses reconcile_pass
  scoped to one kinfolk via kinfolk_id_filter.  Replaces the retired n8n
  auntie-update-profiles synthesis trigger.
"""
from firebase_functions import scheduler_fn, https_fn, options
from firebase_admin import initialize_app

initialize_app()

_MEMORY = options.MemoryOption.MB_512
_REGION = "us-central1"
_SECRETS = ["ANTHROPIC_API_KEY"]


# ---------- on-demand callable body (plain function — testable without Flask) ----------

def _synthesize(req: https_fn.CallableRequest, db_handle) -> dict:
    """On-demand single-kinfolk profile/dossier synthesis.

    Reuses the nightly reconcile pass scoped to one kinfolk via
    kinfolk_id_filter.  Replaces the retired n8n auntie-update-profiles
    synthesis trigger.

    Fail-loud: raises HttpsError for auth failures and bad input; any
    reconcile_pass error surfaces as an unhandled exception (caught by the
    on_call wrapper and returned as INTERNAL to the client).
    """
    from reconcile_comms import reconcile_pass  # lazy — mirrors nightly_reconcile

    # 1. Auth: must be a verified admin.
    if req.auth is None or not req.auth.token.get("admin"):
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.PERMISSION_DENIED,
            message="Admin only",
        )

    # 2. Validate kinfolkId.
    kinfolk_id = (req.data.get("kinfolkId") or "").strip()
    if not kinfolk_id:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            message="kinfolkId required",
        )

    # 3. Run synthesis scoped to this one kinfolk.
    processed = reconcile_pass(
        db_handle,
        max_per_run=500,
        kinfolk_id_filter=kinfolk_id,
        dry_run=False,
    )

    # 4. Return.
    return {"processed": processed, "kinfolkId": kinfolk_id}


# ---------- deployed callable ----------

@https_fn.on_call(
    region=_REGION,
    memory=_MEMORY,
    timeout_sec=300,
    secrets=_SECRETS,
)
def synthesize_kinfolk_profile(req: https_fn.CallableRequest) -> dict:
    """On-demand single-kinfolk profile/dossier synthesis.

    Reuses the nightly reconcile pass scoped to one kinfolk via
    kinfolk_id_filter.  Replaces the retired n8n auntie-update-profiles
    synthesis trigger.

    Args (callable payload):
        kinfolkId (str): The Firestore document ID of the kinfolk to synthesize.

    Returns:
        dict with keys ``processed`` (int) and ``kinfolkId`` (str).

    Raises:
        HttpsError(PERMISSION_DENIED): if the caller is not an authenticated admin.
        HttpsError(INVALID_ARGUMENT): if kinfolkId is missing or blank.
    """
    from reconcile_comms import init_firebase
    db = init_firebase()
    return _synthesize(req, db)


def _recap_recent_comms(req: https_fn.CallableRequest, db_handle, summarize=None) -> dict:
    from reconcile_comms import collect_recent_comms, claude_recap

    if req.auth is None or not req.auth.token.get("admin"):
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.PERMISSION_DENIED,
            message="Admin only",
        )
    kinfolk_id = (req.data.get("kinfolkId") or "").strip()
    if not kinfolk_id:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            message="kinfolkId required",
        )

    entries = collect_recent_comms(db_handle, kinfolk_id)
    if not entries:
        return {"recap": "", "lastAt": "", "sourceCount": 0}

    summarizer = summarize or claude_recap
    recap = (summarizer(entries) or "").strip()
    return {"recap": recap, "lastAt": entries[0]["timestamp"], "sourceCount": len(entries)}


@https_fn.on_call(
    region=_REGION,
    memory=_MEMORY,
    timeout_sec=120,
    secrets=_SECRETS,
)
def recap_recent_comms(req: https_fn.CallableRequest) -> dict:
    from reconcile_comms import init_firebase
    db = init_firebase()
    return _recap_recent_comms(req, db)


def _clear_dossier_household_notes(req: https_fn.CallableRequest, db_handle) -> dict:
    from reconcile_comms import clear_dossier_household_notes_doc

    if req.auth is None or not req.auth.token.get("admin"):
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.PERMISSION_DENIED,
            message="Admin only",
        )
    kinfolk_id = (req.data.get("kinfolkId") or "").strip()
    if not kinfolk_id:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            message="kinfolkId required",
        )
    cleared = clear_dossier_household_notes_doc(db_handle, kinfolk_id)
    return {"kinfolkId": kinfolk_id, "cleared": cleared}


@https_fn.on_call(
    region=_REGION,
    memory=_MEMORY,
    timeout_sec=120,
    secrets=_SECRETS,
)
def clear_dossier_household_notes(req: https_fn.CallableRequest) -> dict:
    from reconcile_comms import init_firebase
    db = init_firebase()
    return _clear_dossier_household_notes(req, db)


# ---------- scheduled nightly pass ----------

@scheduler_fn.on_schedule(
    schedule="0 3 * * *",
    timezone=scheduler_fn.Timezone("America/Chicago"),
    timeout_sec=540,
    memory=_MEMORY,
    secrets=_SECRETS,
    region=_REGION,
)
def nightly_reconcile(event: scheduler_fn.ScheduledEvent) -> None:
    from reconcile_comms import init_firebase, reconcile_pass
    db = init_firebase()
    # WARNING-29: each log can trigger up to ~1 dossier Claude call + N kin-411
    # Claude calls (fan-out), so 500 logs cannot finish inside the 540s timeout.
    # Cap the nightly pass to a budget that fits the window; a backlog is drained
    # across successive nightly runs (claim-first makes re-runs idempotent).
    n = reconcile_pass(db, max_per_run=50, use_stub=False, kinfolk_id_filter=None, dry_run=False)
    print(f"[nightly_reconcile] processed {n} log(s) at {event.schedule_time}")
