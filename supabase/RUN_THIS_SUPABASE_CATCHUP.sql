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
