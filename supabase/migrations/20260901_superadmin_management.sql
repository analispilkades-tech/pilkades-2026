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
