/**
 * #1282: the React Query keys the portal screens read under, in ONE place.
 *
 * Each screen used to spell its own key inline, which was fine while nothing
 * but that screen ever touched it. `lib/portalWarmup.ts` now fetches the same
 * reads the moment the portal opens so the first open of each screen hits a
 * warm Cloud Function instance and, on web, an already-filled cache. That only
 * works if the warm-up and the screen agree on the key to the letter: a
 * warm-up under `['invoices', k]` fills a slot no screen reads and the
 * household pays the cold start anyway, silently. So the key is built here and
 * both sides call the builder; a rename happens in one place or not at all.
 *
 * KEYS ONLY. Each screen keeps its own `queryFn`, `enabled`, `retry` and
 * `staleTime`; those are per-screen decisions (the formSchema reads carry
 * `retry: false` because the schema 404s until an admin seeds one, the
 * payment-method read is gated on billing access, and so on) and centralising
 * them would invite dropping one. `portalWarmup.test.ts` pins the literal
 * shape of every key here, so a rename that forgets one side fails a test.
 *
 * The `kinfolkId` argument is `string | undefined` because that is what
 * `getActiveKinfolkId()` hands the screens; the warm-up always has one.
 */

export const myHomeKey = (kinfolkId: string | undefined) => ['myHome', kinfolkId] as const;

// Invoices (`screens/Invoices.tsx`) and its credit history
// (`components/CreditHistorySection.tsx`). Money: the server refuses a member
// without billing access (#1005).
export const myInvoicesKey = (kinfolkId: string | undefined) => ['myInvoices', kinfolkId] as const;
export const accountCreditHistoryKey = (kinfolkId: string | undefined) => ['accountCreditHistory', kinfolkId] as const;

// Account (`screens/Account.tsx`). The payment method is money too.
export const myAccountKey = (kinfolkId: string | undefined) => ['myAccount', kinfolkId] as const;
export const myPaymentMethodKey = (kinfolkId: string | undefined) => ['myPaymentMethod', kinfolkId] as const;

/**
 * A `getFormSchema` read. Account asks for 'account'; Tribe Profile asks for
 * 'tribeProfile' and 'homeAccess'. Typed to the ids the screens use so a typo
 * in a new caller is a compile error rather than a schema that never arrives.
 */
export const formSchemaKey = (schemaId: 'account' | 'tribeProfile' | 'homeAccess') => ['formSchema', schemaId] as const;

// Notification settings (`screens/NotificationSettings.tsx`). Per signed-in
// user, not per household, so no kinfolkId.
export const notificationCatalogKey = () => ['notificationCatalog'] as const;
export const myNotificationPrefsKey = () => ['myNotificationPrefs'] as const;

// Tribe Profile (`screens/TribeProfile.tsx`); `tribeProfileKey` is also the
// Tribe hub's home-info card.
export const tribeProfileKey = (kinfolkId: string | undefined) => ['tribeProfile', kinfolkId] as const;
export const vetClinicsKey = () => ['vetClinics'] as const;
export const businessContactKey = () => ['businessContact'] as const;
export const membersKey = (kinfolkId: string | undefined) => ['members', kinfolkId] as const;

// Booking wizard (`screens/BookingWizard.tsx`). Closures carry no date range in
// the key: the wizard computes today..horizon inside its queryFn.
export const serviceCatalogKey = (kinfolkId: string | undefined) => ['serviceCatalog', kinfolkId] as const;
export const businessClosuresKey = () => ['businessClosures'] as const;
export const bookingPolicyKey = () => ['bookingPolicy'] as const;

// Schedule (`screens/Schedule.tsx`), the Past Visits tab. The limit sits here
// with the key: the cached list IS what the screen shows until its own
// refetch lands, so a warm-up with a different page would show a different
// list for a moment.
export const PAST_VISITS_LIMIT = 20;
export const myVisitsKey = (kinfolkId: string | undefined) => ['myVisits', kinfolkId] as const;

/**
 * The Tribe hub's photo strip (`screens/TribeHub.tsx`), a plain query of the
 * first page. Gallery reads the same callable as an INFINITE query under
 * `['myKinPhotos', k]`, whose cached shape is `{ pages, pageParams }`; the
 * warm-up fills this one, never that one, because a plain result written
 * under the infinite key would hand Gallery a shape it cannot read.
 */
export const tribeHubPhotosKey = (kinfolkId: string | undefined) => ['myKinPhotos', 'tribe-hub', kinfolkId] as const;
/**
 * #1463: the Tribe hub card reads the same first page the Gallery screen reads
 * (Gallery.tsx PAGE_SIZE). `limit` counts KinTales, not pictures, so a smaller
 * page could come back with no photos for a household that has plenty, and the
 * card would wrongly say there are none. Same number as TribeHubScreen.kt.
 */
export const GALLERY_CARD_PAGE = 12;
