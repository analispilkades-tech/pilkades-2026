# PILKADES 2026 — Production deployment checklist

## 1. Vercel environment variables

Set these as **Secret** environment variables for Production:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase **Secret key**, server-only
- `SESSION_SECRET` — long random value
- `BOT_TOKEN`
- `GDRIVE_WEBHOOK_URL`
- `TELEGRAM_WEBHOOK_SECRET`

`SUPABASE_KEY` is supported only as a backward-compatible fallback. Prefer
`SUPABASE_SERVICE_ROLE_KEY` for the production deployment.

Never put a Supabase key in `/public` or in `NEXT_PUBLIC_*`/browser variables.

## 2. Supabase SQL

Run these migrations in order in the Supabase SQL editor:

1. `supabase/migrations/20260901_production_hardening.sql`
2. `supabase/migrations/20260901_admin_verification_atomic.sql`

The first migration removes the previous public CRUD policies and adds indexes.
It also creates the public live-count view and Telegram deduplication table.
The second migration makes admin approval, rollback, and audit logging atomic.

**Important:** the hardening migration removes direct `anon`/`authenticated`
access to server-owned tables. The Vercel functions therefore must use the
server-only Supabase secret key.

## 3. PIN security

The hardening migration creates `admin_users.pin_hash` and migrates the
existing `pin` values to bcrypt hashes. The login endpoint then verifies only
against `pin_hash` and no longer reads the plaintext `pin` column.

After confirming every admin can log in successfully, remove the legacy
plaintext `pin` column if it is not used by any other system.

## 4. Telegram webhook

Configure Telegram to send the webhook secret in
`X-Telegram-Bot-Api-Secret-Token` using the same value as
`TELEGRAM_WEBHOOK_SECRET`.

The webhook also records `update_id` so Telegram retries do not process the
same update twice.

## 5. Admin verification flow

There is one canonical endpoint:

`POST /api/admin-verifikasi`

Supported actions:

- `SAHKAN_MANUAL` — locks the current values.
- `SAHKAN_PLANO` — applies the latest completed OCR result after confidence validation and locks it.
- `UBAH_DATA` — replaces the vote numbers, recalculates the total server-side, and locks the result.
- `ROLLBACK_VERIFIKASI` — the only action that reopens a `VERIFIED_BY_ADMIN` row and requires a reason.

`RESET_VERIFIKASI` is intentionally removed. It was a duplicate/ambiguous
concept separate from the real rollback workflow.

The database function locks the target row and writes the audit log in the
same transaction. Concurrent admins cannot both successfully change the same
TPS.

## 6. Public live count

`/api/livecount` is the public read endpoint used by `public/index.html`.
`/api/get-data` remains admin-only and must not be used by the public dashboard.

## 7. Validation performed on this package

- All backend JavaScript files pass `node --check`.
- All inline JavaScript blocks in the three HTML pages pass `node --check`.
- No browser/public file imports Supabase.
- No backend file directly constructs a Supabase client with the browser key.
- `RESET_VERIFIKASI` is removed from the production action path.
