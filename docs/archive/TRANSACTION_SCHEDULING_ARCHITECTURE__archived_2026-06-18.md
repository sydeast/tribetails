> ARCHIVED SNAPSHOT (pre-2026-06-18). Superseded by the current /TRANSACTION_SCHEDULING_ARCHITECTURE.md. Kept for history.

# Kinfolk Portal Transaction & Scheduling Wireframe

## Scope

This module defines a wireframe-first scheduling, account, KinTales, and invoice foundation for a Compose Multiplatform portal.

The current code is intentionally display-oriented. It is meant to communicate structure, flow, and high-end tactile visual direction before production Firebase/KFire integration.

## Data hierarchy

- `families/{familyId}/bookings/{bookingId}`
- `families/{familyId}/bookingLocks/{lockId}`
- `families/{familyId}/kinTales/{taleId}`
- `families/{familyId}/members/{uid}`

## Kin vs. Kinfolk

Bookings use `BookingTargetType`:

- `KIN`: animal, pet, or vet-oriented booking.
- `KINFOLK`: human appointment or family-member booking.

Each booking stores `targetId` so the same repository can schedule a human or animal without merging their identity models.

## Wireframe booking behavior

`WireframeBookingRepository` uses local `MutableStateFlow` data so the module can display bookings, availability, invoice cards, and KinTales without a live backend.

## Production double-booking direction

`KFireBookingRepository.reserveBooking` writes both a booking document and a deterministic `bookingLocks` document inside a Firestore transaction.

The lock id is derived from:

- target type
- target id
- start instant
- end instant

If an existing lock is found for the same target and window, the transaction fails before writing the booking.

## KFire integration boundary

The empty workspace does not include concrete KFire dependencies, so `KFirePorts.kt` defines small adapter interfaces matching the repository needs:

- typed collections
- typed queries
- snapshot flows
- Firestore transactions

When the real KFire SDK is added, bind these ports to the SDK's concrete Firestore APIs. Until then, use `WireframeBookingRepository`.

## Placeholder display data

`PlaceholderTransactionData.kt` includes Kai Foster demo records:

- one `KINFOLK` booking
- one `KIN` vet booking
- one KinTale with rich-media storage paths

Use `TransactionDemoScreen` to render the tactile timeline, invoice card, settings panel, and KinTales feed.

## UI direction

The UI avoids Material/Tailwind visual paradigms in the product surfaces:

- `KinCalendarTimeline` draws the horizontal fluid date picker on Canvas.
- `KinShaders.softSilkBackground` provides SkSL for a soft silk/paper runtime shader.
- `GlassmorphicInvoiceViewer` uses `graphicsLayer` to create tactile elevation and translucent card treatment.
- `AccountSettingsPanel` uses custom scale/lift touch feedback.

## Security model

Firestore rules allow family members to read booking confirmations and KinTales. Invoice/payment fields are protected so only `ADMIN` family members can create or edit invoicing data.
