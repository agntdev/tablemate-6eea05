# TableReserve — Bot specification

**Archetype:** booking

**Voice:** warm and concise — write every user-facing message, button label, error, and empty state in this voice.

A polite Telegram reservation assistant for restaurants that shows only genuinely available start times, lets guests book, reschedule, or cancel via inline buttons, issues short reference codes, sends guest reminders, and delivers owner/admin notifications and a daily capacity overview.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Restaurant guests who want to make, change, or cancel table reservations via Telegram
- Restaurant owner and staff who need an admin inbox and a daily capacity overview

## Success criteria

- Guests can create confirmed bookings via Telegram with a generated short reference code
- Bot never shows start-times that would exceed configured table capacity (no overbooked slots)
- Guests receive immediate confirmation and a reminder X hours before the booking
- Owner/admin receives notifications for new bookings, cancellations, reschedules, and a daily summary each morning
- Owner can view and mark bookings (e.g., no-show) from an admin inbox and receive an accurate capacity overview

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open the main menu and begin a new reservation or view an existing booking via reference code
- **Reserve table** (button, actor: user, callback: booking:start) — Begin the guided reservation flow (date → time → party size → contact → confirm)
  - outputs: date selection UI, available time slots for selected date, party size selection UI
- **My booking** (button, actor: user, callback: booking:lookup) — Lookup or manage an existing booking by reference or phone
  - inputs: reference code or phone number (ForceReply) if not available in chat profile
  - outputs: booking summary, inline [Reschedule] and [Cancel] buttons
- **/help** (command, actor: user, command: /help) — Show help and available actions
- **Admin inbox** (button, actor: owner, callback: admin:inbox) — Open owner admin view with upcoming bookings and daily capacity (owner only)
  - outputs: list of upcoming bookings, capacity summary, action buttons [Mark no-show], [Cancel], [Contact guest]

## Flows

### Guest booking (create)
_Trigger:_ /start or booking:start

1. Show welcome and primary actions (Reserve table, My booking, Help)
2. If Reserve table chosen: show calendar seeded with next booking_window days (default 30)
3. User selects a date (via inline calendar button callbacks)
4. Bot computes available start times (15-minute granularity) and shows only slots with capacity
5. User selects a time (button)
6. Bot asks party size (preset buttons e.g., 1–2, 3–4, 5–6, Custom → ForceReply for custom number)
7. Optional: ask guest for contact (phone via ForceReply or share contact button) and name (optional)
8. Bot computes table assignment and shows confirmation card with summary, generated short reference code, and buttons [Confirm], [Change], [Cancel]
9. On Confirm: persist booking, send immediate confirmation to guest, schedule reminder job, notify ADMIN_CHAT_ID

_Data touched:_ Booking, TableModel, RestaurantRules, Guest, NotificationSubscription

### Availability computation
_Trigger:_ date selection or table/config change event

1. Load RestaurantRules (opening hours, sitting duration, booking window, lead time) and TableModel
2. Enumerate candidate start times for date in 15-minute steps within opening hours and respecting lead time
3. For each candidate, simulate table assignments avoiding overlaps with existing confirmed bookings and reserved table spans
4. Return only start times where at least one valid table-assignment set covers party sizes up to configured maximum
5. If simultaneous booking attempts occur, lock availability window for the start-time range during final confirmation to prevent race conditions

_Data touched:_ Booking, TableModel, RestaurantRules

### Reschedule flow
_Trigger:_ user uses [Reschedule] button on booking summary or admin triggers reschedule

1. Authenticate booking ownership via reference code or phone match
2. Show calendar seeded with allowed window and compute availability excluding the target booking's own current reservation (so it can move)
3. User selects new date/time/party size as needed
4. Bot validates new assignment, updates booking record with new time and status rescheduled, regenerates or preserves reference code per owner preference
5. Notify guest with updated confirmation and owner via ADMIN_CHAT_ID

_Data touched:_ Booking, TableModel

### Cancellation flow
_Trigger:_ user presses [Cancel] or owner cancels from admin inbox

1. Confirm cancellation with a Yes/No inline prompt
2. On confirm: update booking.status to cancelled, free any assigned tables, cancel scheduled reminder job
3. Notify guest and owner (ADMIN_CHAT_ID) with cancellation details

_Data touched:_ Booking

### Reminder delivery
_Trigger:_ scheduled job X hours before booking (reminder_offset)

1. For each booking with reminders enabled and status confirmed, send a polite reminder message to the guest with booking summary and inline options [Reschedule] and [Cancel]
2. If message fails (chat blocked or user not reachable), record delivery failure and include it in owner daily summary

_Data touched:_ Booking, NotificationSubscription

### Admin daily summary
_Trigger:_ scheduled job every morning (owner local time)

1. Compile upcoming bookings for the configured day(s), capacity utilization, and any failed reminder deliveries or conflicts
2. Send summary to ADMIN_CHAT_ID with inline navigation to individual booking cards for actions [Mark no-show], [Cancel], [Contact guest]
3. Owner actions update bookings and notify guest as required

_Data touched:_ Booking, OwnerSettings

### Mark no-show
_Trigger:_ owner presses [Mark no-show] in admin inbox

1. Owner confirms action via inline prompt
2. Update booking.status to no-show, optionally tag for reporting, and include in next daily summary
3. Optional: record a manual note entered by owner

_Data touched:_ Booking

## Owner-supplied settings

The OWNER provides these; they are collected in chat and injected into the environment at deploy. Read each one from the environment where it is used (`ctx.env.<KEY>` / `env.<KEY>` on Cloudflare Workers; `process.env.<KEY>` only as a Node/harness fallback — never the sole read). Do NOT invent your own way of learning the value, do NOT ask for it in a bot message, and do NOT hardcode a default.

- **ADMIN_CHAT_ID** — where new booking and daily summary notifications are sent
  - this is the OWNER's own chat id; the platform already knows it. Read `ADMIN_CHAT_ID` via `ctx.env` (prefer toolkit `adminChatId` / `requireOwner`) — never ask a user, never treat whoever writes first as the admin, never invent claim-admin or open manage for everyone.
  - may be UNSET at runtime: the bot must still start, and the feature needing ADMIN_CHAT_ID must say so plainly instead of failing.

Your behavioral specs run WITHOUT these values, so no spec may depend on one.

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

An entity that merely NAMES an owner-supplied setting above (an admin chat, an API account) is not something to store or discover — read it from the environment.

- **Booking** _(retention: persistent)_ — A single table reservation record
  - fields: id (internal UUID), reference_code (short, human-friendly), guest_label (name or anonymized label), phone (optional), party_size, date (local restaurant date), start_time (local), duration_minutes, assigned_tables (list of table ids), status (confirmed | cancelled | rescheduled | no-show), created_at, updated_at, reminder_sent_at (nullable)
- **TableModel** _(retention: persistent)_ — Owner-configured layout of tables and seating capacity
  - fields: table_id, seats, count (if using template groups), optional table label/zone
- **RestaurantRules** _(retention: persistent)_ — Operational rules controlling booking constraints
  - fields: opening_hours (per weekday ranges), sitting_duration_minutes, min_lead_time_minutes, booking_window_days, time_granularity_minutes, reminder_offset_minutes, timezone (owner must confirm)
- **Guest** _(retention: persistent)_ — Guest contact and opt-in preferences
  - fields: guest_label, phone (optional), telegram_user_id (nullable if anonymous), opt_in_reminders (boolean), created_at
- **OwnerSettings** _(retention: persistent)_ — Owner/admin configuration and preferences
  - fields: ADMIN_CHAT_ID, notification_preferences, default_sitting_duration, default_reminder_offset, time_zone, locale
- **NotificationSubscription** _(retention: persistent)_ — Tracks scheduled reminder jobs and delivery state
  - fields: booking_id, scheduled_at, status (scheduled | sent | failed | cancelled), failure_reason (nullable)

## Integrations

- **Telegram** (required) — Bot API messaging, inline keyboards, callback queries, scheduled messages (reminders)
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Configure opening hours per weekday
- Define table model (number of tables and seats per table) and edit table labels/zones
- Set sitting duration (default 90 minutes), min lead time, booking window (days), and reminder offset
- Enable/disable guest reminders globally
- Receive new booking, cancellation, reschedule, and daily summary notifications at ADMIN_CHAT_ID
- Open admin inbox to view upcoming bookings, capacity utilization, and take actions (Cancel, Mark no-show, Contact guest)
- Export bookings list (missing export formats in missing_fields)
- Change reservation window or close dates (owner edits that could conflict with existing bookings require explicit confirmation)

## Notifications

- Immediate guest confirmation message after booking with short reference code
- Owner notification to ADMIN_CHAT_ID for new bookings, cancellations, and reschedules
- Automated guest reminder X hours before booking (default 2 hours)
- Daily capacity and bookings summary to ADMIN_CHAT_ID each morning
- Delivery-failure notices included in daily summary when guest reminders cannot be delivered

## Permissions & privacy

- Guest phone and name are optional; if neither provided, generate anonymized guest label (e.g., Guest-XYZ)
- All persisted booking and configuration data is private and accessible only to owner/admin actions
- Reminders are sent only to Telegram chats that engaged with the bot (opt-in tracked)
- Owner-admin notifications are sent only to the configured ADMIN_CHAT_ID
- Retention policy length and export compliance (e.g., GDPR) not specified in brief — see missing_fields

## Edge cases

- Simultaneous booking attempts for the same final table(s): implement optimistic locking or short server-side reservation lock during confirmation
- Timezone and DST differences between owner and guests: restaurant timezone must be stored and applied when showing dates/times
- Owner changes table model or sitting duration that would invalidate existing bookings — require admin confirmation and create conflict report
- Guest blocks bot or deletes chat: reminder delivery failure must be logged and shown to owner
- Min lead time blocks last-minute bookings: show clear error and next available slot when user attempts to book too close to start time
- Parties larger than any single table (require combining tables): algorithm must combine tables when possible; if impossible, hide slot
- Partial capacity left (e.g., a 2-seat table free but party size 4): ensure slot hidden if no valid table combination covers party size
- Missing ADMIN_CHAT_ID: bot must refuse owner notifications and surface setup prompt to owner before accepting bookings (owner-facing guard)

## Required tests

- Dialog-level acceptance test: full create booking flow (date → time → party → contact → confirm) results in persisted booking, confirmation sent, and owner notified
- Availability correctness test: given set of existing bookings and table model, UI never shows fully-booked start times
- Reschedule acceptance test: user-initiated reschedule updates booking, frees prior tables, assigns new tables, and notifies owner
- Cancellation test: user cancels and booking becomes cancelled and reminder job removed; owner notified
- Concurrency test: two parallel booking attempts for the same slot — only one succeeds and the other receives a polite availability-failed message and fresh options
- Reminder delivery test: scheduled reminder is sent at configured offset; failure path recorded and surfaced to owner summary
- Admin inbox test: owner receives daily summary and can mark no-show and cancel bookings from the admin view

## Assumptions

- Default opening hours are Mon–Sun 11:00–22:00 unless owner configures otherwise
- Default sitting duration is 90 minutes unless owner sets another value
- Default table model seed is 5×2-seat and 8×4-seat to avoid an empty layout at first-run
- Booking window defaults to 30 days and time slot granularity to 15 minutes
- Reminders default to 2 hours before booking; guests can opt out by toggling preferences or by not providing contact
- All times are stored and presented in the restaurant's configured timezone (owner must confirm timezone during setup)
- No external payment or third-party calendar integrations are required
