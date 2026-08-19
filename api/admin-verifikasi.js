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
      admin_nama
    } = req.body || {};


    if (!id) {
      return res.status(400).json({
        ok: false,
        error: 'ID hasil_suara wajib diisi'
      });
    }


    if (
      ![
        'SAHKAN_MANUAL',
        'SAHKAN_PLANO'
      ].includes(action)
    ) {

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
     * HANYA BOLEH DIVERIFIKASI JIKA MEMERLUKAN ADMIN
     * =========================================================
     */

    if (
      hasil.status_verifikasi !==
      'MEMERLUKAN VERIFIKASI ADMIN'
    ) {

      return res.status(400).json({
        ok: false,

        error:
          `Status saat ini adalah "${hasil.status_verifikasi}". ` +
          `Data tidak berada dalam antrean verifikasi admin.`
      });

    }


    /*
     * =========================================================
     * SAHKAN MANUAL
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
       * Ambil OCR terbaru
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


      if (planoError || !plano) {

        return res.status(404).json({
          ok: false,
          error:
            'Hasil OCR plano belum tersedia'
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
