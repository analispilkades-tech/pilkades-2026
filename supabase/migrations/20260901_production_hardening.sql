-- PILKADES 2026 - production hardening
-- Run this once in Supabase SQL Editor AFTER setting
-- SUPABASE_SERVICE_ROLE_KEY in Vercel.
-- This intentionally removes direct public access to server-owned tables.

revoke all on table
  public.hasil_suara,
  public.log_aktivitas,
  public.plano_uploads,
  public.admin_users,
  public.admin_sessions,
  public.admin_kecamatan,
  public.master_desa,
  public.master_petugas
from anon, authenticated;

-- Remove the known public policies from the previous configuration.
drop policy if exists "Public Insert Livecount" on public.hasil_suara;
drop policy if exists "Public Read Livecount" on public.hasil_suara;
drop policy if exists "Public Update Livecount" on public.hasil_suara;
drop policy if exists "Public Read Log" on public.log_aktivitas;
drop policy if exists "Public Write Log" on public.log_aktivitas;

-- Useful indexes for high-volume admin/session traffic.
create index if not exists idx_admin_sessions_token_hash
  on public.admin_sessions(token_hash);

create index if not exists idx_admin_sessions_expires_at
  on public.admin_sessions(expires_at);

create index if not exists idx_admin_users_nrp_aktif
  on public.admin_users(nrp, aktif);

create index if not exists idx_admin_kecamatan_admin_id
  on public.admin_kecamatan(admin_id);

create index if not exists idx_hasil_suara_kecamatan
  on public.hasil_suara(kecamatan);

create index if not exists idx_plano_uploads_hasil_created
  on public.plano_uploads(hasil_suara_id, created_at desc);

-- No client role should execute server-only RPCs created later.

-- Latest completed OCR per TPS. This prevents admin polling from reading
-- the complete plano history on every 10-second refresh.
create or replace view public.latest_plano_uploads as
select distinct on (hasil_suara_id)
  id,
  hasil_suara_id,
  google_drive_url,
  ocr_status,
  ocr_engine,
  ocr_text,
  ocr_calon_01,
  ocr_calon_02,
  ocr_calon_03,
  ocr_calon_04,
  ocr_calon_05,
  ocr_tidak_sah,
  ocr_total_suara,
  ocr_confidence,
  ocr_started_at,
  ocr_processed_at,
  ocr_error,
  created_at
from public.plano_uploads
where ocr_status = 'COMPLETED'
order by hasil_suara_id, created_at desc nulls last, id desc;

revoke all on public.latest_plano_uploads from anon, authenticated;

-- Telegram webhook idempotency: Telegram may retry the same update.
create table if not exists public.telegram_updates (
  update_id bigint primary key,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists idx_telegram_updates_processed_at
  on public.telegram_updates(processed_at);

revoke all on public.telegram_updates from anon, authenticated;

-- Password/PIN hardening. The current application stores PINs in admin_users.pin;
-- migrate them to bcrypt hashes before relying on this login function.
create extension if not exists pgcrypto;

alter table public.admin_users
  add column if not exists pin_hash text;

update public.admin_users
set pin_hash = crypt(pin::text, gen_salt('bf', 12))
where pin_hash is null
  and pin is not null;

create or replace function public.admin_login_verify(
  p_nrp text,
  p_pin text
)
returns table (
  id bigint,
  nrp text,
  nama text,
  role text,
  kecamatan text,
  aktif boolean
)
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select a.id, a.nrp::text, a.nama::text, a.role::text,
         a.kecamatan::text, a.aktif
  from public.admin_users a
  where a.nrp::text = trim(p_nrp)
    and a.aktif = true
    and a.pin_hash is not null
    and a.pin_hash = crypt(p_pin, a.pin_hash)
  limit 1;
$$;

revoke all on function public.admin_login_verify(text, text) from public, anon, authenticated;
grant execute on function public.admin_login_verify(text, text) to service_role;
