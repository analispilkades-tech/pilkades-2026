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
grant select on public.latest_plano_uploads to service_role;

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


-- ============================================================
-- 2) ATOMIC ADMIN VERIFICATION / ROLLBACK
-- ============================================================

-- PILKADES 2026 - atomic admin verification/rollback
-- Run after 20260901_production_hardening.sql.
-- The function is SECURITY DEFINER and callable only by service_role.

create or replace function public.admin_vote_int(p_data jsonb, p_key text)
returns integer
language plpgsql
immutable
as $$
declare
  v text;
  n numeric;
begin
  v := nullif(trim(coalesce(p_data ->> p_key, '')), '');
  if v is null then return 0; end if;
  if v !~ '^\d+(\.0+)?$' then return 0; end if;
  n := floor(v::numeric);
  return least(greatest(n, 0), 10000000)::integer;
exception when others then
  return 0;
end;
$$;

create or replace function public.admin_apply_verification_action(
  p_admin_id text,
  p_hasil_id bigint,
  p_action text,
  p_data jsonb default null,
  p_rollback_reason text default null,
  p_min_ocr_confidence numeric default 40
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin record;
  v_hasil public.hasil_suara%rowtype;
  v_before jsonb;
  v_updated public.hasil_suara%rowtype;
  v_plano record;
  v_action text := upper(trim(coalesce(p_action, '')));
  v_reason text := trim(coalesce(p_rollback_reason, ''));
  v_confidence numeric;
  v_total integer;
  v_c1 integer;
  v_c2 integer;
  v_c3 integer;
  v_c4 integer;
  v_c5 integer;
  v_invalid boolean := false;
begin
  if v_action not in ('SAHKAN_MANUAL','SAHKAN_PLANO','UBAH_DATA','ROLLBACK_VERIFIKASI') then
    raise exception using message = 'INVALID_ACTION: Aksi admin tidak valid.';
  end if;

  select id, nrp, nama, role, aktif, kecamatan
    into v_admin
  from public.admin_users
  where id::text = p_admin_id
  limit 1;

  if not found or not coalesce(v_admin.aktif, false) then
    raise exception using message = 'ADMIN_NOT_ACTIVE: Akun admin tidak aktif atau tidak ditemukan.';
  end if;

  -- Lock the target row for the entire transaction. This prevents two admins
  -- from approving/rolling back the same TPS at the same time.
  select * into v_hasil
  from public.hasil_suara
  where id = p_hasil_id
  for update;

  if not found then
    raise exception using message = 'DATA_NOT_FOUND: Data hasil suara tidak ditemukan.';
  end if;

  -- Authorization is checked inside the same transaction as the mutation.
  if upper(trim(coalesce(v_admin.role, ''))) not in ('SUPERADMIN','SUPER_ADMIN') then
    if not exists (
      select 1
      from public.admin_kecamatan ak
      where ak.admin_id::text = p_admin_id
        and upper(trim(coalesce(ak.kecamatan, ''))) = upper(trim(coalesce(v_hasil.kecamatan, '')))
    ) then
      raise exception using message = 'KECAMATAN_ACCESS_DENIED: Admin tidak memiliki hak akses untuk kecamatan ini.';
    end if;
  end if;

  v_before := to_jsonb(v_hasil);

  if v_hasil.status_verifikasi = 'VERIFIED_BY_ADMIN'
     and v_action <> 'ROLLBACK_VERIFIKASI' then
    raise exception using message = 'DATA_ALREADY_VERIFIED: Data sudah diverifikasi dan dikunci. Rollback Verifikasi diperlukan sebelum perubahan berikutnya.';
  end if;

  if v_action = 'ROLLBACK_VERIFIKASI' then
    if v_reason = '' then
      raise exception using message = 'ROLLBACK_REASON_REQUIRED: Alasan rollback wajib diisi.';
    end if;
    if length(v_reason) < 5 then
      raise exception using message = 'ROLLBACK_REASON_TOO_SHORT: Alasan rollback minimal 5 karakter.';
    end if;
    if length(v_reason) > 1000 then
      raise exception using message = 'ROLLBACK_REASON_TOO_LONG: Alasan rollback maksimal 1000 karakter.';
    end if;
    if v_hasil.status_verifikasi <> 'VERIFIED_BY_ADMIN' then
      raise exception using message = 'DATA_NOT_VERIFIED: Data belum berstatus VERIFIED_BY_ADMIN sehingga tidak perlu di-rollback.';
    end if;

    update public.hasil_suara
       set status_verifikasi = 'MEMERLUKAN VERIFIKASI ADMIN'
     where id = p_hasil_id
       and status_verifikasi = 'VERIFIED_BY_ADMIN'
    returning * into v_updated;

    if not found then
      raise exception using message = 'ROLLBACK_FAILED: Status data berubah sebelum rollback selesai.';
    end if;

    insert into public.log_aktivitas (
      sumber_aksi, jenis_aksi, nrp_saksi, nama_saksi,
      kecamatan, desa, tps, data_sebelum, data_sesudah,
      keterangan, rollback_reason
    ) values (
      'ADMIN_PANEL', 'ADMIN_ROLLBACK_VERIFIKASI',
      v_hasil.nrp_saksi, v_hasil.nama_saksi,
      v_hasil.kecamatan, v_hasil.desa, v_hasil.tps,
      v_before, to_jsonb(v_updated),
      '[Admin: ' || coalesce(v_admin.nama, v_admin.nrp, 'Admin') || '] Admin melakukan rollback verifikasi dan membuka kembali data untuk audit/review.',
      v_reason
    );

    return jsonb_build_object(
      'ok', true,
      'message', 'Rollback verifikasi berhasil. Data kembali ke antrean verifikasi admin.',
      'status_verifikasi', v_updated.status_verifikasi,
      'rollback_reason', v_reason,
      'data', to_jsonb(v_updated)
    );
  end if;

  if v_action = 'SAHKAN_MANUAL' then
    update public.hasil_suara
       set status_verifikasi = 'VERIFIED_BY_ADMIN'
     where id = p_hasil_id
       and status_verifikasi <> 'VERIFIED_BY_ADMIN'
    returning * into v_updated;

    if not found then
      raise exception using message = 'DATA_ALREADY_CHANGED: Data sudah dikunci atau diproses admin lain.';
    end if;

    insert into public.log_aktivitas (
      sumber_aksi, jenis_aksi, nrp_saksi, nama_saksi,
      kecamatan, desa, tps, data_sebelum, data_sesudah,
      keterangan, rollback_reason
    ) values (
      'ADMIN_PANEL', 'ADMIN_SAHKAN_MANUAL',
      v_hasil.nrp_saksi, v_hasil.nama_saksi,
      v_hasil.kecamatan, v_hasil.desa, v_hasil.tps,
      v_before, to_jsonb(v_updated),
      '[Admin: ' || coalesce(v_admin.nama, v_admin.nrp, 'Admin') || '] Admin mengesahkan hasil input manual. Angka livecount tidak diubah.',
      null
    );

    return jsonb_build_object(
      'ok', true,
      'message', 'Hasil input manual berhasil disahkan admin.',
      'status_verifikasi', v_updated.status_verifikasi,
      'data', to_jsonb(v_updated)
    );
  end if;

  if v_action = 'SAHKAN_PLANO' then
    select * into v_plano
    from public.plano_uploads
    where hasil_suara_id = p_hasil_id
      and ocr_status = 'COMPLETED'
    order by created_at desc nulls last, id desc
    limit 1;

    if not found then
      raise exception using message = 'PLANO_NOT_READY: Hasil OCR plano belum tersedia.';
    end if;

    v_confidence := coalesce(v_plano.ocr_confidence::numeric, 0);
    if v_confidence < coalesce(p_min_ocr_confidence, 40) then
      raise exception using message = 'OCR_CONFIDENCE_TOO_LOW: Plano tidak dapat disahkan karena confidence OCR hanya ' || v_confidence || '. Minimum ' || coalesce(p_min_ocr_confidence, 40) || '.';
    end if;

    v_c1 := public.admin_vote_int(to_jsonb(v_plano), 'ocr_calon_01');
    v_c2 := public.admin_vote_int(to_jsonb(v_plano), 'ocr_calon_02');
    v_c3 := public.admin_vote_int(to_jsonb(v_plano), 'ocr_calon_03');
    v_c4 := public.admin_vote_int(to_jsonb(v_plano), 'ocr_calon_04');
    v_c5 := public.admin_vote_int(to_jsonb(v_plano), 'ocr_calon_05');
    v_total := v_c1 + v_c2 + v_c3 + v_c4 + v_c5 + public.admin_vote_int(to_jsonb(v_plano), 'ocr_tidak_sah');

    update public.hasil_suara
       set suara_calon_01 = v_c1,
           suara_calon_02 = v_c2,
           suara_calon_03 = v_c3,
           suara_calon_04 = v_c4,
           suara_calon_05 = v_c5,
           suara_tidak_sah = public.admin_vote_int(to_jsonb(v_plano), 'ocr_tidak_sah'),
           total_suara_masuk = v_total,
           status_verifikasi = 'VERIFIED_BY_ADMIN'
     where id = p_hasil_id
       and status_verifikasi <> 'VERIFIED_BY_ADMIN'
    returning * into v_updated;

    if not found then
      raise exception using message = 'DATA_ALREADY_CHANGED: Data sudah dikunci atau diproses admin lain.';
    end if;

    insert into public.log_aktivitas (
      sumber_aksi, jenis_aksi, nrp_saksi, nama_saksi,
      kecamatan, desa, tps, data_sebelum, data_sesudah,
      keterangan, rollback_reason
    ) values (
      'ADMIN_PANEL', 'ADMIN_SAHKAN_PLANO',
      v_hasil.nrp_saksi, v_hasil.nama_saksi,
      v_hasil.kecamatan, v_hasil.desa, v_hasil.tps,
      v_before, to_jsonb(v_updated),
      '[Admin: ' || coalesce(v_admin.nama, v_admin.nrp, 'Admin') || '] Admin mengesahkan hasil plano/OCR. Confidence=' || v_confidence || '.',
      null
    );

    return jsonb_build_object(
      'ok', true,
      'message', 'Hasil plano berhasil disahkan admin.',
      'status_verifikasi', v_updated.status_verifikasi,
      'confidence', v_confidence,
      'total', v_total,
      'applied', jsonb_build_object(
        'suara_calon_01', v_c1,
        'suara_calon_02', v_c2,
        'suara_calon_03', v_c3,
        'suara_calon_04', v_c4,
        'suara_calon_05', v_c5,
        'suara_tidak_sah', public.admin_vote_int(to_jsonb(v_plano), 'ocr_tidak_sah')
      ),
      'data', to_jsonb(v_updated)
    );
  end if;

  -- UBAH_DATA
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception using message = 'INVALID_DATA: Data perubahan wajib berupa object JSON.';
  end if;

  v_c1 := public.admin_vote_int(p_data, 'suara_calon_01');
  v_c2 := public.admin_vote_int(p_data, 'suara_calon_02');
  v_c3 := public.admin_vote_int(p_data, 'suara_calon_03');
  v_c4 := public.admin_vote_int(p_data, 'suara_calon_04');
  v_c5 := public.admin_vote_int(p_data, 'suara_calon_05');
  v_total := v_c1 + v_c2 + v_c3 + v_c4 + v_c5 + public.admin_vote_int(p_data, 'suara_tidak_sah');

  update public.hasil_suara
     set suara_calon_01 = v_c1,
         suara_calon_02 = v_c2,
         suara_calon_03 = v_c3,
         suara_calon_04 = v_c4,
         suara_calon_05 = v_c5,
         suara_tidak_sah = public.admin_vote_int(p_data, 'suara_tidak_sah'),
         total_suara_masuk = v_total,
         status_verifikasi = 'VERIFIED_BY_ADMIN'
   where id = p_hasil_id
     and status_verifikasi <> 'VERIFIED_BY_ADMIN'
  returning * into v_updated;

  if not found then
    raise exception using message = 'DATA_ALREADY_CHANGED: Data sudah dikunci atau diproses admin lain.';
  end if;

  insert into public.log_aktivitas (
    sumber_aksi, jenis_aksi, nrp_saksi, nama_saksi,
    kecamatan, desa, tps, data_sebelum, data_sesudah,
    keterangan, rollback_reason
  ) values (
    'ADMIN_PANEL', 'ADMIN_UBAH_DATA',
    v_hasil.nrp_saksi, v_hasil.nama_saksi,
    v_hasil.kecamatan, v_hasil.desa, v_hasil.tps,
    v_before, to_jsonb(v_updated),
    '[Admin: ' || coalesce(v_admin.nama, v_admin.nrp, 'Admin') || '] Admin melakukan koreksi angka hasil suara secara manual dan langsung mengesahkan data.',
    null
  );

  return jsonb_build_object(
    'ok', true,
    'message', 'Data hasil suara berhasil diubah dan disahkan admin.',
    'status_verifikasi', v_updated.status_verifikasi,
    'total', v_total,
    'data', to_jsonb(v_updated)
  );
end;
$$;

revoke all on function public.admin_vote_int(jsonb, text) from public, anon, authenticated;
revoke all on function public.admin_apply_verification_action(text, bigint, text, jsonb, text, numeric) from public, anon, authenticated;
grant execute on function public.admin_apply_verification_action(text, bigint, text, jsonb, text, numeric) to service_role;


-- ============================================================
-- 3) SUPERADMIN MANAGEMENT
-- ============================================================

-- PILKADES 2026 - controlled Superadmin management
-- Run AFTER production_hardening.sql.
-- This deliberately exposes controlled CRUD, not arbitrary SQL/table editing.

create or replace function public.superadmin_manage_admin(
  p_actor_admin_id text,
  p_action text,
  p_admin_id text default null,
  p_nrp text default null,
  p_nama text default null,
  p_role text default null,
  p_pin text default null,
  p_aktif boolean default null,
  p_kecamatan text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_actor public.admin_users%rowtype;
  v_target public.admin_users%rowtype;
  v_action text := upper(trim(coalesce(p_action, '')));
  v_role text := upper(trim(coalesce(p_role, '')));
  v_nrp text := trim(coalesce(p_nrp, ''));
  v_nama text := trim(coalesce(p_nama, ''));
  v_regions text[];
  v_data jsonb;
begin
  select * into v_actor
  from public.admin_users
  where id::text = p_actor_admin_id
  limit 1;

  if not found or not coalesce(v_actor.aktif, false) then
    raise exception using message = 'ADMIN_NOT_ACTIVE: Akun admin tidak aktif atau tidak ditemukan.';
  end if;

  if upper(trim(coalesce(v_actor.role, ''))) not in ('SUPERADMIN', 'SUPER_ADMIN') then
    raise exception using message = 'SUPERADMIN_REQUIRED: Hanya SUPERADMIN yang boleh mengelola admin.';
  end if;

  if v_action = 'LIST_KECAMATAN' then
    select coalesce(jsonb_agg(x.kecamatan order by x.kecamatan), '[]'::jsonb)
      into v_data
    from (
      select distinct upper(trim(kecamatan)) as kecamatan
      from public.master_desa
      where nullif(trim(kecamatan), '') is not null
    ) x;
    return jsonb_build_object('data', v_data);
  end if;

  if v_action = 'LIST_ADMINS' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id,
      'nrp', a.nrp,
      'nama', a.nama,
      'role', a.role,
      'kecamatan', a.kecamatan,
      'aktif', a.aktif,
      'created_at', a.created_at,
      'wilayah', coalesce((select jsonb_agg(ak.kecamatan order by ak.kecamatan) from public.admin_kecamatan ak where ak.admin_id = a.id), '[]'::jsonb)
    ) order by a.id), '[]'::jsonb)
      into v_data
    from public.admin_users a;
    return jsonb_build_object('data', v_data);
  end if;

  if p_admin_id is null or p_admin_id !~ '^\d+$' then
    raise exception using message = 'INVALID_ADMIN_ID: ID admin tidak valid.';
  end if;

  select * into v_target
  from public.admin_users
  where id::text = p_admin_id
  for update;

  if not found then
    raise exception using message = 'TARGET_NOT_FOUND: Admin tidak ditemukan.';
  end if;

  if v_action = 'SET_ADMIN_STATUS' then
    if p_aktif is null then
      raise exception using message = 'INVALID_STATUS: Status aktif wajib diisi.';
    end if;
    if v_target.id = v_actor.id and p_aktif = false then
      raise exception using message = 'CANNOT_DEACTIVATE_SELF: SUPERADMIN tidak boleh menonaktifkan akunnya sendiri.';
    end if;

    update public.admin_users set aktif = p_aktif where id = v_target.id returning * into v_target;

    insert into public.log_aktivitas (
      sumber_aksi, jenis_aksi, nrp_saksi, nama_saksi, keterangan, data_sebelum, data_sesudah
    ) values (
      'SUPERADMIN_PANEL', 'ADMIN_SET_STATUS', v_target.nrp, v_target.nama,
      '[Superadmin: ' || coalesce(v_actor.nama, v_actor.nrp, 'Superadmin') || '] Mengubah status admin.',
      jsonb_build_object('id', v_target.id, 'aktif', not p_aktif),
      jsonb_build_object('id', v_target.id, 'aktif', p_aktif)
    );

    return jsonb_build_object('data', jsonb_build_object('id', v_target.id, 'aktif', v_target.aktif));
  end if;

  if v_action = 'UPDATE_ADMIN' then
    if nullif(v_nama, '') is null then
      raise exception using message = 'NAME_REQUIRED: Nama admin wajib diisi.';
    end if;
    if nullif(v_role, '') is null or v_role not in ('ADMIN', 'SUPERADMIN', 'SUPER_ADMIN') then
      raise exception using message = 'INVALID_ROLE: Role harus ADMIN, SUPERADMIN, atau SUPER_ADMIN.';
    end if;
    if nullif(v_nrp, '') is null then
      raise exception using message = 'NRP_REQUIRED: NRP wajib diisi.';
    end if;

    if exists (select 1 from public.admin_users where nrp = v_nrp and id <> v_target.id) then
      raise exception using message = 'DUPLICATE_NRP: NRP sudah digunakan admin lain.';
    end if;

    update public.admin_users
       set nrp = v_nrp,
           nama = v_nama,
           role = v_role,
           aktif = coalesce(p_aktif, aktif),
           pin_hash = case when nullif(p_pin, '') is not null then crypt(p_pin, gen_salt('bf', 12)) else pin_hash end,
           pin = null
     where id = v_target.id
     returning * into v_target;

  elsif v_action = 'CREATE_ADMIN' then
    if nullif(v_nrp, '') is null then raise exception using message = 'NRP_REQUIRED: NRP wajib diisi.'; end if;
    if nullif(v_nama, '') is null then raise exception using message = 'NAME_REQUIRED: Nama admin wajib diisi.'; end if;
    if v_role not in ('ADMIN', 'SUPERADMIN', 'SUPER_ADMIN') then raise exception using message = 'INVALID_ROLE: Role harus ADMIN, SUPERADMIN, atau SUPER_ADMIN.'; end if;
    if nullif(p_pin, '') is null or length(p_pin) < 4 or length(p_pin) > 128 then raise exception using message = 'INVALID_PIN: PIN wajib 4-128 karakter.'; end if;
    if exists (select 1 from public.admin_users where nrp = v_nrp) then raise exception using message = 'DUPLICATE_NRP: NRP sudah digunakan admin lain.'; end if;

    insert into public.admin_users (nrp, nama, role, aktif, pin_hash, pin)
    values (v_nrp, v_nama, v_role, coalesce(p_aktif, true), crypt(p_pin, gen_salt('bf', 12)), null)
    returning * into v_target;
  else
    raise exception using message = 'INVALID_ACTION: Aksi pengelolaan admin tidak valid.';
  end if;

  if v_role in ('SUPERADMIN', 'SUPER_ADMIN') then
    delete from public.admin_kecamatan where admin_id = v_target.id;
  else
    if p_kecamatan is null then
      if v_action = 'CREATE_ADMIN' then
        raise exception using message = 'REGION_REQUIRED: Admin biasa wajib memiliki minimal satu kecamatan.';
      end if;
      v_regions := array(select upper(trim(x)) from public.admin_kecamatan where admin_id = v_target.id and nullif(trim(x), '') is not null);
    else
      v_regions := array(
        select distinct upper(trim(x))
        from unnest(p_kecamatan) x
        where nullif(trim(x), '') is not null
      );
    end if;

    if coalesce(array_length(v_regions, 1), 0) = 0 then
      raise exception using message = 'REGION_REQUIRED: Admin biasa wajib memiliki minimal satu kecamatan.';
    end if;

    if exists (
      select 1 from unnest(v_regions) r
      where not exists (select 1 from public.master_desa m where upper(trim(m.kecamatan)) = r)
    ) then
      raise exception using message = 'REGION_NOT_FOUND: Ada kecamatan yang tidak ditemukan di master_desa.';
    end if;

    delete from public.admin_kecamatan where admin_id = v_target.id;
    insert into public.admin_kecamatan (admin_id, kecamatan)
    select v_target.id, r from unnest(v_regions) r;
  end if;

  insert into public.log_aktivitas (
    sumber_aksi, jenis_aksi, nrp_saksi, nama_saksi, keterangan, data_sebelum, data_sesudah
  ) values (
    'SUPERADMIN_PANEL',
    case when v_action = 'CREATE_ADMIN' then 'ADMIN_CREATE' else 'ADMIN_UPDATE' end,
    v_target.nrp, v_target.nama,
    '[Superadmin: ' || coalesce(v_actor.nama, v_actor.nrp, 'Superadmin') || '] Mengelola akun admin.',
    case when v_action = 'CREATE_ADMIN' then null else jsonb_build_object('id', v_target.id) end,
    jsonb_build_object('id', v_target.id, 'nrp', v_target.nrp, 'nama', v_target.nama, 'role', v_target.role, 'aktif', v_target.aktif,
      'wilayah', coalesce((select jsonb_agg(ak.kecamatan order by ak.kecamatan) from public.admin_kecamatan ak where ak.admin_id = v_target.id), '[]'::jsonb))
  );

  return jsonb_build_object(
    'data', jsonb_build_object(
      'id', v_target.id,
      'nrp', v_target.nrp,
      'nama', v_target.nama,
      'role', v_target.role,
      'aktif', v_target.aktif,
      'wilayah', coalesce((select jsonb_agg(ak.kecamatan order by ak.kecamatan) from public.admin_kecamatan ak where ak.admin_id = v_target.id), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function public.superadmin_manage_admin(text,text,text,text,text,text,text,boolean,text[]) from public, anon, authenticated;
grant execute on function public.superadmin_manage_admin(text,text,text,text,text,text,text,boolean,text[]) to service_role;


-- PILKADES 2026 - Phase 1 canonical PETUGAS result transaction engine
-- Run after the existing production hardening / admin verification SQL.
-- Server-only: callable by service_role only.
--
-- Business rules:
--   1) One canonical hasil_suara row per kecamatan/desa/tps.
--   2) First submission inserts the row.
--   3) A second petugas cannot overwrite an existing TPS.
--   4) The owner of an unverified result may correct it.
--   5) VERIFIED_BY_ADMIN is locked for petugas.
--   6) Every insert/correction writes log_aktivitas in the same transaction.
--   7) Telegram/Web callers use this same engine; clients never decide ownership.

create or replace function public.petugas_result_apply(
  p_operation text,
  p_nrp text,
  p_chat_id text default null,
  p_kecamatan text default null,
  p_desa text default null,
  p_tps text default null,
  p_votes jsonb default null,
  p_source text default 'TELEGRAM_BOT',
  p_input_format text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_operation text := upper(trim(coalesce(p_operation, '')));
  v_nrp text := trim(coalesce(p_nrp, ''));
  v_chat text := nullif(trim(coalesce(p_chat_id, '')), '');
  v_kecamatan text;
  v_desa text;
  v_tps text;
  v_source text := upper(trim(coalesce(p_source, 'TELEGRAM_BOT')));
  v_petugas public.master_petugas%rowtype;
  v_master public.master_desa%rowtype;
  v_hasil public.hasil_suara%rowtype;
  v_updated public.hasil_suara%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_c1 integer := 0;
  v_c2 integer := 0;
  v_c3 integer := 0;
  v_c4 integer := 0;
  v_c5 integer := 0;
  v_ts integer := 0;
  v_total integer := 0;
  v_existing jsonb;
  v_input_format text := nullif(trim(coalesce(p_input_format, '')), '');
  v_key text;
  v_val numeric;
begin
  if v_operation not in ('SUBMIT_NEW_RESULT', 'CORRECT_OWN_RESULT') then
    return jsonb_build_object(
      'ok', false,
      'code', 'INVALID_OPERATION',
      'message', 'Operasi hasil petugas tidak valid.'
    );
  end if;

  if v_nrp = '' then
    return jsonb_build_object('ok', false, 'code', 'PETUGAS_REQUIRED', 'message', 'NRP petugas wajib diisi.');
  end if;

  if p_votes is null or jsonb_typeof(p_votes) <> 'object' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_VOTES', 'message', 'Data suara tidak valid.');
  end if;

  -- Lock the petugas row so Telegram/Web cannot race against a simultaneous
  -- identity update for the same NRP.
  select * into v_petugas
  from public.master_petugas
  where nrp::text = v_nrp
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'PETUGAS_NOT_FOUND', 'message', 'Petugas tidak ditemukan.');
  end if;

  -- Telegram supplies chat_id. Web PETUGAS can omit it and relies on the
  -- authenticated server-side session identity.
  if v_chat is not null and coalesce(v_petugas.chat_id_telegram, '') <> v_chat then
    return jsonb_build_object('ok', false, 'code', 'PETUGAS_IDENTITY_MISMATCH', 'message', 'Identitas petugas tidak cocok dengan sesi Telegram.');
  end if;

  -- Resolve the TPS from master data. We use the canonical values stored in
  -- master_desa for the actual hasil_suara row, rather than trusting client
  -- spelling/casing.
  select * into v_master
  from public.master_desa
  where upper(trim(kecamatan)) = upper(trim(coalesce(p_kecamatan, '')))
    and upper(trim(desa)) = upper(trim(coalesce(p_desa, '')))
    and trim(tps) = trim(coalesce(p_tps, ''))
  limit 1;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'code', 'TPS_NOT_IN_MASTER',
      'message', 'TPS tidak ditemukan pada master desa. Data petugas tidak disimpan.'
    );
  end if;

  if upper(trim(coalesce(v_petugas.kecamatan, ''))) <> upper(trim(v_master.kecamatan))
     or upper(trim(coalesce(v_petugas.desa, ''))) <> upper(trim(v_master.desa)) then
    return jsonb_build_object(
      'ok', false,
      'code', 'PETUGAS_LOCATION_DENIED',
      'message', 'Petugas tidak memiliki akses ke kecamatan/desa TPS tersebut.'
    );
  end if;

  v_kecamatan := v_master.kecamatan;
  v_desa := v_master.desa;
  v_tps := v_master.tps;

  -- Parse only known candidate slots. Missing candidates beyond jumlah_calon
  -- are zeroed; values outside 0..10,000,000 are rejected.
  for i in 1..5 loop
    v_key := 'calon_' || lpad(i::text, 2, '0');
    if p_votes ? v_key then
      begin
        v_val := (p_votes ->> v_key)::numeric;
      exception when others then
        return jsonb_build_object('ok', false, 'code', 'INVALID_VOTE_VALUE', 'message', 'Nilai suara harus berupa angka bulat.');
      end;
      if v_val is null or v_val <> floor(v_val) or v_val < 0 or v_val > 10000000 then
        return jsonb_build_object('ok', false, 'code', 'INVALID_VOTE_VALUE', 'message', 'Nilai suara harus berupa bilangan bulat 0 sampai 10.000.000.');
      end if;
      if i = 1 then v_c1 := v_val::integer;
      elsif i = 2 then v_c2 := v_val::integer;
      elsif i = 3 then v_c3 := v_val::integer;
      elsif i = 4 then v_c4 := v_val::integer;
      elsif i = 5 then v_c5 := v_val::integer;
      end if;
    end if;
  end loop;

  if v_master.jumlah_calon is null or v_master.jumlah_calon < 2 or v_master.jumlah_calon > 5 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_MASTER_CANDIDATE_COUNT', 'message', 'Jumlah calon pada master TPS harus 2 sampai 5.');
  end if;

  if v_master.jumlah_calon < 5 then v_c5 := 0; end if;
  if v_master.jumlah_calon < 4 then v_c4 := 0; end if;
  if v_master.jumlah_calon < 3 then v_c3 := 0; end if;

  begin
    v_val := coalesce((p_votes ->> 'tidak_sah')::numeric, 0);
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'INVALID_VOTE_VALUE', 'message', 'Nilai tidak sah harus berupa angka bulat.');
  end;
  if v_val <> floor(v_val) or v_val < 0 or v_val > 10000000 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_VOTE_VALUE', 'message', 'Nilai tidak sah harus berupa bilangan bulat 0 sampai 10.000.000.');
  end if;
  v_ts := v_val::integer;
  v_total := v_c1 + v_c2 + v_c3 + v_c4 + v_c5 + v_ts;

  -- A non-positive DPT means master data is incomplete; do not silently
  -- accept production input against an unknown DPT.
  if coalesce(v_master.total_dpt, 0) <= 0 then
    return jsonb_build_object('ok', false, 'code', 'DPT_NOT_READY', 'message', 'Total DPT TPS belum tersedia pada master desa.');
  end if;

  if v_total > v_master.total_dpt then
    return jsonb_build_object(
      'ok', false,
      'code', 'DPT_EXCEEDED',
      'message', 'Total suara melebihi DPT TPS.',
      'total', v_total,
      'dpt', v_master.total_dpt
    );
  end if;

  if v_operation = 'SUBMIT_NEW_RESULT' then
    -- Lock an existing row if present. If none exists, insert below and let the
    -- existing UNIQUE(kecamatan,desa,tps) constraint be the final race guard.
    select * into v_hasil
    from public.hasil_suara
    where kecamatan = v_kecamatan
      and desa = v_desa
      and tps = v_tps
    for update;

    if found then
      v_existing := jsonb_build_object(
        'id', v_hasil.id,
        'nrp_saksi', v_hasil.nrp_saksi,
        'nama_saksi', v_hasil.nama_saksi,
        'status_verifikasi', v_hasil.status_verifikasi,
        'timestamp', v_hasil.timestamp
      );
      return jsonb_build_object(
        'ok', false,
        'code', 'TPS_ALREADY_FILLED',
        'message', 'TPS sudah memiliki hasil. Petugas lain tidak boleh menimpa hasil tersebut.',
        'existing', v_existing
      );
    end if;

    begin
      insert into public.hasil_suara (
        kecamatan, desa, tps,
        nrp_saksi, nama_saksi,
        suara_calon_01, suara_calon_02, suara_calon_03, suara_calon_04, suara_calon_05,
        suara_tidak_sah, total_suara_masuk,
        input_format, status_verifikasi, chat_id_saksi,
        active_source,
        input_manual_calon_01, input_manual_calon_02, input_manual_calon_03,
        input_manual_calon_04, input_manual_calon_05, input_manual_tidak_sah,
        input_manual_total,
        timestamp
      ) values (
        v_kecamatan, v_desa, v_tps,
        v_petugas.nrp, v_petugas.nama_petugas,
        v_c1, v_c2, v_c3, v_c4, v_c5,
        v_ts, v_total,
        v_input_format, 'MEMERLUKAN VERIFIKASI ADMIN',
        v_chat,
        v_source,
        v_c1, v_c2, v_c3, v_c4, v_c5, v_ts,
        v_total,
        now()
      ) returning * into v_updated;
    exception when unique_violation then
      -- Another request won the race. Return the existing row rather than ever
      -- falling back to UPDATE.
      select * into v_hasil
      from public.hasil_suara
      where kecamatan = v_kecamatan and desa = v_desa and tps = v_tps
      limit 1;
      return jsonb_build_object(
        'ok', false,
        'code', 'TPS_ALREADY_FILLED',
        'message', 'TPS baru saja diinput oleh petugas lain. Data Anda tidak menimpa data yang sudah ada.',
        'existing', jsonb_build_object(
          'id', v_hasil.id,
          'nrp_saksi', v_hasil.nrp_saksi,
          'nama_saksi', v_hasil.nama_saksi,
          'status_verifikasi', v_hasil.status_verifikasi,
          'timestamp', v_hasil.timestamp
        )
      );
    end;

    v_after := to_jsonb(v_updated);

    insert into public.log_aktivitas (
      sumber_aksi, jenis_aksi, nrp_saksi, nama_saksi,
      kecamatan, desa, tps, data_sebelum, data_sesudah, keterangan
    ) values (
      v_source, 'PETUGAS_SUBMIT_HASIL', v_petugas.nrp, v_petugas.nama_petugas,
      v_kecamatan, v_desa, v_tps, null, v_after,
      'Petugas menyimpan hasil TPS melalui canonical result engine.'
    );

    return jsonb_build_object(
      'ok', true,
      'code', 'CREATED',
      'message', 'Hasil TPS berhasil disimpan dan menunggu verifikasi admin.',
      'data', v_after
    );
  end if;

  -- CORRECT_OWN_RESULT
  select * into v_hasil
  from public.hasil_suara
  where kecamatan = v_kecamatan
    and desa = v_desa
    and tps = v_tps
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'RESULT_NOT_FOUND', 'message', 'Belum ada hasil TPS yang dapat dikoreksi.');
  end if;

  if trim(coalesce(v_hasil.nrp_saksi, '')) <> v_petugas.nrp::text then
    return jsonb_build_object(
      'ok', false,
      'code', 'RESULT_OWNER_MISMATCH',
      'message', 'Hasil TPS sudah dimiliki petugas lain. Anda tidak boleh mengoreksinya.',
      'existing', jsonb_build_object(
        'id', v_hasil.id,
        'nrp_saksi', v_hasil.nrp_saksi,
        'nama_saksi', v_hasil.nama_saksi,
        'status_verifikasi', v_hasil.status_verifikasi,
        'timestamp', v_hasil.timestamp
      )
    );
  end if;

  if upper(trim(coalesce(v_hasil.status_verifikasi, ''))) = 'VERIFIED_BY_ADMIN' then
    return jsonb_build_object(
      'ok', false,
      'code', 'RESULT_ALREADY_VERIFIED',
      'message', 'Hasil sudah diverifikasi admin dan terkunci. Petugas tidak boleh mengoreksinya.'
    );
  end if;

  v_before := to_jsonb(v_hasil);

  update public.hasil_suara
     set suara_calon_01 = v_c1,
         suara_calon_02 = v_c2,
         suara_calon_03 = v_c3,
         suara_calon_04 = v_c4,
         suara_calon_05 = v_c5,
         suara_tidak_sah = v_ts,
         total_suara_masuk = v_total,
         input_format = v_input_format,
         input_manual_calon_01 = v_c1,
         input_manual_calon_02 = v_c2,
         input_manual_calon_03 = v_c3,
         input_manual_calon_04 = v_c4,
         input_manual_calon_05 = v_c5,
         input_manual_tidak_sah = v_ts,
         input_manual_total = v_total,
         status_verifikasi = 'MEMERLUKAN VERIFIKASI ADMIN',
         active_source = v_source,
         chat_id_saksi = coalesce(v_chat, chat_id_saksi),
         timestamp = now()
   where id = v_hasil.id
     and upper(trim(coalesce(status_verifikasi, ''))) <> 'VERIFIED_BY_ADMIN'
  returning * into v_updated;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'RESULT_CHANGED_CONCURRENTLY', 'message', 'Status hasil berubah saat koreksi. Silakan periksa kembali.');
  end if;

  v_after := to_jsonb(v_updated);

  insert into public.log_aktivitas (
    sumber_aksi, jenis_aksi, nrp_saksi, nama_saksi,
    kecamatan, desa, tps, data_sebelum, data_sesudah, keterangan
  ) values (
    v_source, 'PETUGAS_CORRECT_HASIL', v_petugas.nrp, v_petugas.nama_petugas,
    v_kecamatan, v_desa, v_tps, v_before, v_after,
    'Petugas mengoreksi hasil miliknya sendiri sebelum verifikasi admin. Data kembali menunggu verifikasi admin.'
  );

  return jsonb_build_object(
    'ok', true,
    'code', 'CORRECTED',
    'message', 'Koreksi hasil TPS berhasil disimpan dan dikembalikan ke antrean verifikasi admin.',
    'data', v_after
  );
end;
$$;

revoke all on function public.petugas_result_apply(text, text, text, text, text, text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.petugas_result_apply(text, text, text, text, text, text, jsonb, text, text)
  to service_role;
