\"\"\"
Proposal for Backend (Baserow / Postgres) Schema for AuntieOS Admin Migration
-------------------------------------------------------------------------
This script outlines the required tables and fields needed to support the Admin Migration Phase 1.

1. ADMIN_USERS Table
- id: Primary Key
- first_name: Text
- last_name: Text
- kinfolk_view_name: Text (What users see)
- email: Text (Unique)
- password_hash: Text
- profile_picture_url: File/URL
- role: Text (Admin, Staff, etc.)

2. EVENTS Table (Schedules, Bookings, Blocked Dates, Holidays)
- id: Primary Key
- title: Text
- start_time: DateTime
- end_time: DateTime
- event_type: Single Select (KIN_CARE, BLOCKED_DATE, HOLIDAY, PERSONAL)
- status: Single Select (DRAFT, ACCEPTED, REJECTED, COMPLETED)
- notes: Long Text
- kin_id: Link to KIN Table
- google_calendar_event_id: Text (For GCal sync tracking)

3. ACTIVITY_LOGS Table (Audit Trail)
- id: Primary Key
- timestamp: DateTime (Auto-created)
- user_id: Link to ADMIN_USERS Table (Optional for system events)
- action_type: Text (e.g., LOGIN, LOGOUT, CREATE_BOOKING, UPDATE_SETTINGS)
- description: Long Text
- status: Single Select (SUCCESS, FAILURE)
- ip_address: Text (Optional, for security tracing)

Architecture / Design Recommendations for Backend:
1. Google Calendar Integration:
   - Use a Webhook or CRON job (via n8n) to sync `PERSONAL` events periodically or listen to GCal push notifications.
   - Store the `google_calendar_event_id` to prevent duplicates and handle updates/deletes natively.
2. Activity Logs Volume:
   - This table will grow rapidly. Implement a weekly archiver (via n8n) that exports logs older than 90 days to cold storage (e.g., S3) and deletes them from Baserow.
3. Authentication:
   - Rate limiting on `login` and `forgot password` endpoints is critical. Use Redis or an in-memory cache on your API gateway to block IPs with >5 failed attempts.
\"\"\"
