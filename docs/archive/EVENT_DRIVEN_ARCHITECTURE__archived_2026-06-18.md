> ARCHIVED SNAPSHOT (pre-2026-06-18). Superseded by the current /EVENT_DRIVEN_ARCHITECTURE.md. Kept for history.

# Kinfolk Portal — Event-Driven Architecture

## Overview

The Kinfolk Portal uses an event-driven separation between the **client app** (family/owner experience) and the **admin/sitter app** (caretaker operations). Firebase Cloud Functions bridge the two, with FCM pushing real-time visit updates to client devices.

## Separation of Concerns

### Client Portal (This App)
- Creates **booking requests** in Firestore
- Reads visit status, sitter check-ins, and report photos (read-only)
- Receives FCM push notifications for live visit milestones
- Views invoices and submits payment via Stripe (mock)
- Cannot mutate `assignedTo`, `assignedSitterId`, `invoiceStatus`, or `sitterRate`

### Admin / Sitter App (Separate)
- Confirms booking requests → writes `assignedSitterId`
- Updates `visitEvents` subcollection in real time
- Triggers FCM notifications via Cloud Functions
- Manages sitter payouts and invoice status

## Firestore Collections

```
clients/{clientId}
families/{familyId}
  ├── members/{uid}
  ├── kin/{kinId}          (animal profiles)
  ├── kinfolk/{kinfolkId}   (human profiles)
  ├── bookings/{bookingId}
  │     └── visitEvents/{eventId}   (live sitter updates)
  ├── kinTales/{taleId}
  └── invoices/{invoiceId}
fcmTokens/{tokenId}
```

## Cloud Functions

### 1. `onBookingCreated`
**Trigger:** `families/{familyId}/bookings/{bookingId}` — onCreate
**Action:**
- Validates booking request fields
- Sends admin notification via FCM to family admins
- Sets initial `status = REQUESTED`

### 2. `onBookingConfirmed`
**Trigger:** Admin app updates `assignedSitterId`
**Action:**
- Atomically creates `visitEvents` with `CONFIRMED` status
- Sends FCM to client: "Your visit is confirmed — {sitterName} will arrive {date}"

### 3. `onVisitEventCreated`
**Trigger:** `families/{familyId}/visitEvents/{eventId}` — onCreate
**Action:**
- Reads `status` and routes notification:
  - `SITTER_EN_ROUTE` → "Avery is on the way"
  - `VISIT_STARTED`   → "Visit has begun"
  - `CHECK_IN_COMPLETE` → "Check-in complete — see photos"
  - `VISIT_ENDED`     → "Visit complete. Report incoming."
  - `REPORT_SUBMITTED` → "Your KinTale is ready!"
- Pushes FCM to all tokens registered for `familyId`

### 4. `onInvoicePaid`
**Trigger:** Stripe webhook → updates `paymentStatus = CAPTURED`
**Action:**
- Updates booking `invoiceStatus = PAID`
- Sends receipt FCM to client
- Triggers Cloud Function for admin revenue sync

## FCM Message Structure

```json
{
  "token": "<device_fcm_token>",
  "notification": {
    "title": "Kinfolk Visit Update",
    "body": "Avery has arrived — Nova is already doing laps."
  },
  "data": {
    "familyId": "family-foster",
    "bookingId": "evt-grandma-bash",
    "eventId": "evt-003",
    "visitStatus": "VISIT_STARTED",
    "deepLink": "/visit/evt-grandma-bash"
  }
}
```

## Security Rules Enforcement

- Clients can **create** bookings but cannot set `assignedTo`, `assignedSitterId`, or invoice fields
- Clients can **read** `visitEvents` but cannot write them (only admin app + Cloud Functions)
- Sitters update `visitEvents`; clients receive them via FCM + Firestore snapshot listeners
- `kin` profile mutation is limited to care instructions (feeding, walking, sitter notes)
- `kinfolk` self-edit is limited to phone, email, avatar, contact preference

## Mock / Wireframe Notes

- `WireframeBookingRepository` simulates local reactive state without Firebase
- `VisitStatusTimeline` consumes `VisitEvent` list and animates entries
- FCM is not wired in the wireframe; the architecture document above serves as the production blueprint
