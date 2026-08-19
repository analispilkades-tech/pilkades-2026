import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export default async function handler(req, res) {

  res.setHeader(
    'Access-Control-Allow-Origin',
    '*'
  );

  res.setHeader(
    'Access-Control-Allow-Methods',
    'POST, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {

    const {
      id,
      action,
      admin_nama,

      suara_calon_01,
      suara_calon_02,
      suara_calon_03,
      suara_calon_04,
      suara_calon_05,
      suara_tidak_sah

    } = req.body || {};

    if (!id) {
      return res.status(400).json({
        ok: false,
        error: 'ID hasil_suara wajib diisi'
      });
    }

    const ACTIONS = [
      'SAHKAN_MANUAL',
      'SAHKAN_PLANO',
      'EDIT_HASIL'
    ];

    if (!ACTIONS.includes(action)) {
      return res.status(400).json({
        ok: false,
        error: 'Aksi admin tidak valid'
      });
    }

    /*
     * =========================================================
     * AMBIL DATA HASIL SUARA
     * =========================================================
     */

    const {
      data: hasil,
      error: hasilError
    } = await supabase
      .from('hasil_suara')
      .select('*')
      .eq('id', id)
      .single();

    if (hasilError || !hasil) {
      return res.status(404).json({
        ok: false,
        error: 'Data hasil suara tidak ditemukan'
      });
    }

    /*
     * =========================================================
     * SAHKAN MANUAL
     *
     * Admin boleh mengesahkan hasil manual selama
     * data belum dikunci sebagai final.
     * =========================================================
     */

    if (action === 'SAHKAN_MANUAL') {

      const {
        error: updateError
      } = await supabase
        .from('hasil_suara')
        .update({
          status_verifikasi: 'VERIFIED_BY_ADMIN'
        })
        .eq('id', id);

      if (updateError) {
        return res.status(500).json({
          ok: false,
          error: updateError.message
        });
      }

      /*
       * AUDIT LOG
       */

      await supabase
        .from('log_aktivitas')
        .insert({
          sumber_aksi: 'ADMIN_PANEL',
          jenis_aksi: 'ADMIN_SAHKAN_MANUAL',

          nrp_saksi:
            hasil.nrp_saksi,

          nama_saksi:
            hasil.nama_saksi,

          kecamatan:
            hasil.kecamatan,

          desa:
            hasil.desa,

          tps:
            hasil.tps,

          data_sebelum: {
            status_verifikasi:
              hasil.status_verifikasi
          },

          data_sesudah: {
            status_verifikasi:
              'VERIFIED_BY_ADMIN'
          },

          keterangan:
            `Admin ${admin_nama || 'Admin'} ` +
            `mengesahkan hasil input manual TPS ${hasil.tps}`
        });

      console.log(
        `[ADMIN] ${admin_nama || 'Admin'} ` +
        `mengesahkan INPUT MANUAL ` +
        `hasil_suara ID=${id}`
      );

      return res.status(200).json({
        ok: true,
        message:
          'Hasil input manual berhasil disahkan admin',

        status_verifikasi:
          'VERIFIED_BY_ADMIN'
      });
    }

    /*
     * =========================================================
     * SAHKAN PLANO
     * =========================================================
     */

    if (action === 'SAHKAN_PLANO') {

      /*
       * Ambil OCR TERBARU yang benar-benar COMPLETED.
       *
       * SKIPPED / FAILED / LOW_CONFIDENCE tidak boleh
       * diterapkan ke Live Count.
       */

      const {
        data: plano,
        error: planoError
      } = await supabase
        .from('plano_uploads')
        .select('*')
        .eq('hasil_suara_id', id)
        .eq('ocr_status', 'COMPLETED')
        .order('created_at', {
          ascending: false
        })
        .limit(1)
        .maybeSingle();

      if (planoError) {
        return res.status(500).json({
          ok: false,
          error: planoError.message
        });
      }

      if (!plano) {
        return res.status(400).json({
          ok: false,
          error:
            'Tidak ada hasil OCR plano yang valid untuk disahkan.'
        });
      }

      /*
       * Confidence minimum
       */

      const confidence =
        Number(plano.ocr_confidence || 0);

      if (confidence < 40) {
        return res.status(400).json({
          ok: false,
          error:
            `Hasil OCR tidak memenuhi batas confidence. ` +
            `Confidence=${confidence}, minimum=40.`
        });
      }

      /*
       * Hitung total
       */

      const total =
        Number(plano.ocr_calon_01 || 0) +
        Number(plano.ocr_calon_02 || 0) +
        Number(plano.ocr_calon_03 || 0) +
        Number(plano.ocr_calon_04 || 0) +
        Number(plano.ocr_calon_05 || 0) +
        Number(plano.ocr_tidak_sah || 0);

      /*
       * Simpan data sebelum
       */

      const dataSebelum = {
        suara_calon_01:
          hasil.suara_calon_01,

        suara_calon_02:
          hasil.suara_calon_02,

        suara_calon_03:
          hasil.suara_calon_03,

        suara_calon_04:
          hasil.suara_calon_04,

        suara_calon_05:
          hasil.suara_calon_05,

        suara_tidak_sah:
          hasil.suara_tidak_sah,

        total_suara_masuk:
          hasil.total_suara_masuk,

        status_verifikasi:
          hasil.status_verifikasi
      };

      /*
       * Terapkan hasil plano ke Live Count
       */

      const {
        error: updateError
      } = await supabase
        .from('hasil_suara')
        .update({

          suara_calon_01:
            plano.ocr_calon_01,

          suara_calon_02:
            plano.ocr_calon_02,

          suara_calon_03:
            plano.ocr_calon_03,

          suara_calon_04:
            plano.ocr_calon_04,

          suara_calon_05:
            plano.ocr_calon_05,

          suara_tidak_sah:
            plano.ocr_tidak_sah,

          total_suara_masuk:
            total,

          status_verifikasi:
            'VERIFIED_BY_ADMIN'

        })
        .eq('id', id);

      if (updateError) {
        return res.status(500).json({
          ok: false,
          error: updateError.message
        });
      }

      /*
       * AUDIT LOG
       */

      await supabase
        .from('log_aktivitas')
        .insert({

          sumber_aksi:
            'ADMIN_PANEL',

          jenis_aksi:
            'ADMIN_SAHKAN_PLANO',

          nrp_saksi:
            hasil.nrp_saksi,

          nama_saksi:
            hasil.nama_saksi,

          kecamatan:
            hasil.kecamatan,

          desa:
            hasil.desa,

          tps:
            hasil.tps,

          data_sebelum:
            dataSebelum,

          data_sesudah: {

            suara_calon_01:
              plano.ocr_calon_01,

            suara_calon_02:
              plano.ocr_calon_02,

            suara_calon_03:
              plano.ocr_calon_03,

            suara_calon_04:
              plano.ocr_calon_04,

            suara_calon_05:
              plano.ocr_calon_05,

            suara_tidak_sah:
              plano.ocr_tidak_sah,

            total_suara_masuk:
              total,

            status_verifikasi:
              'VERIFIED_BY_ADMIN'
          },

          keterangan:
            `Admin ${admin_nama || 'Admin'} ` +
            `mengesahkan hasil plano TPS ${hasil.tps}. ` +
            `Plano upload ID=${plano.id}`
        });

      console.log(
        `[ADMIN] ${admin_nama || 'Admin'} ` +
        `mengesahkan HASIL PLANO ` +
        `hasil_suara ID=${id}`
      );

      return res.status(200).json({

        ok: true,

        message:
          'Hasil plano berhasil disahkan admin',

        status_verifikasi:
          'VERIFIED_BY_ADMIN',

        applied: {

          calon_01:
            plano.ocr_calon_01,

          calon_02:
            plano.ocr_calon_02,

          calon_03:
            plano.ocr_calon_03,

          calon_04:
            plano.ocr_calon_04,

          calon_05:
            plano.ocr_calon_05,

          tidak_sah:
            plano.ocr_tidak_sah,

          total
        }
      });
    }

    /*
     * =========================================================
     * EDIT HASIL
     * =========================================================
     */

    if (action === 'EDIT_HASIL') {

      const nilai = [
        suara_calon_01,
        suara_calon_02,
        suara_calon_03,
        suara_calon_04,
        suara_calon_05,
        suara_tidak_sah
      ];

      /*
       * Semua nilai harus berupa angka >= 0
       */

      for (const value of nilai) {

        if (
          value !== null &&
          value !== undefined &&
          (
            !Number.isFinite(Number(value)) ||
            Number(value) < 0
          )
        ) {

          return res.status(400).json({
            ok: false,
            error:
              'Nilai suara harus berupa angka >= 0'
          });

        }
      }

      const calon01 =
        Number(suara_calon_01 ?? 0);

      const calon02 =
        Number(suara_calon_02 ?? 0);

      const calon03 =
        Number(suara_calon_03 ?? 0);

      const calon04 =
        Number(suara_calon_04 ?? 0);

      const calon05 =
        Number(suara_calon_05 ?? 0);

      const tidakSah =
        Number(suara_tidak_sah ?? 0);

      const total =
        calon01 +
        calon02 +
        calon03 +
        calon04 +
        calon05 +
        tidakSah;

      const dataSebelum = {
        suara_calon_01:
          hasil.suara_calon_01,

        suara_calon_02:
          hasil.suara_calon_02,

        suara_calon_03:
          hasil.suara_calon_03,

        suara_calon_04:
          hasil.suara_calon_04,

        suara_calon_05:
          hasil.suara_calon_05,

        suara_tidak_sah:
          hasil.suara_tidak_sah,

        total_suara_masuk:
          hasil.total_suara_masuk,

        status_verifikasi:
          hasil.status_verifikasi
      };

      const dataSesudah = {
        suara_calon_01: calon01,
        suara_calon_02: calon02,
        suara_calon_03: calon03,
        suara_calon_04: calon04,
        suara_calon_05: calon05,
        suara_tidak_sah: tidakSah,
        total_suara_masuk: total,
        status_verifikasi:
          'VERIFIED_BY_ADMIN'
      };

      const {
        error: updateError
      } = await supabase
        .from('hasil_suara')
        .update(dataSesudah)
        .eq('id', id);

      if (updateError) {

        return res.status(500).json({
          ok: false,
          error: updateError.message
        });

      }

      /*
       * AUDIT LOG EDIT ADMIN
       */

      await supabase
        .from('log_aktivitas')
        .insert({

          sumber_aksi:
            'ADMIN_PANEL',

          jenis_aksi:
            'ADMIN_EDIT_HASIL',

          nrp_saksi:
            hasil.nrp_saksi,

          nama_saksi:
            hasil.nama_saksi,

          kecamatan:
            hasil.kecamatan,

          desa:
            hasil.desa,

          tps:
            hasil.tps,

          data_sebelum:
            dataSebelum,

          data_sesudah:
            dataSesudah,

          keterangan:
            `Admin ${admin_nama || 'Admin'} ` +
            `mengubah hasil suara TPS ${hasil.tps}.`
        });

      return res.status(200).json({

        ok: true,

        message:
          'Data hasil suara berhasil diubah dan disahkan admin',

        status_verifikasi:
          'VERIFIED_BY_ADMIN',

        data:
          dataSesudah
      });
    }

  } catch (err) {

    console.error(
      '[ADMIN VERIFIKASI] ERROR:',
      err
    );

    return res.status(500).json({
      ok: false,
      error:
        err.message ||
        'Server error'
    });
  }
}

<td class="p-3 text-center">
  ${renderAdminActions(item)}
</td>
