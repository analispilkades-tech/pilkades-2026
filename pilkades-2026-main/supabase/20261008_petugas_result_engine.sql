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
