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
