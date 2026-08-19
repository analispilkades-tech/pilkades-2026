import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {

    /*
     * =========================================================
     * 1. HASIL SUARA / LIVE COUNT
     * =========================================================
     */

    const { data: hasilData, error: hasilErr } = await supabase
      .from('hasil_suara')
      .select('*')
      .order('id', { ascending: false });

    if (hasilErr) {
      console.error(
        'Error fetch hasil_suara:',
        hasilErr
      );
    }


    /*
     * =========================================================
     * 2. MASTER DESA
     * =========================================================
     */

    const { data: masterData, error: masterErr } = await supabase
      .from('master_desa')
      .select('*');

    if (masterErr) {
      console.error(
        'Error fetch master_desa:',
        masterErr
      );
    }


    /*
     * =========================================================
     * 3. PLANO TERBARU
     *
     *    Ambil OCR terbaru untuk setiap hasil_suara.
     * =========================================================
     */

    const { data: planoData, error: planoErr } = await supabase
      .from('plano_uploads')
      .select(`
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
      `)
      .order('id', { ascending: false });

    if (planoErr) {
      console.error(
        'Error fetch plano_uploads:',
        planoErr
      );
    }


    const safeHasil =
      Array.isArray(hasilData)
        ? hasilData
        : [];

    const safeMaster =
      Array.isArray(masterData)
        ? masterData
        : [];

    const safePlano =
      Array.isArray(planoData)
        ? planoData
        : [];


    /*
     * =========================================================
     * 4. MAP MASTER
     * =========================================================
     */

    const masterMap = {};

    safeMaster.forEach(m => {

      const kKec =
        String(m.kecamatan || '')
          .toUpperCase()
          .trim();

      const kDesa =
        String(m.desa || '')
          .toUpperCase()
          .trim();

      const kTps =
        String(m.tps || '')
          .toUpperCase()
          .trim();

      const key =
        `${kKec}_${kDesa}_${kTps}`;

      masterMap[key] = {
        jumlah_calon:
          Number(m.jumlah_calon || 2),

        total_dpt:
          Number(
            m.total_dpt ??
            m.dpt ??
            0
          )
      };
    });


    /*
     * =========================================================
     * 5. MAP PLANO TERBARU
     * =========================================================
     */

    const planoMap = {};

    safePlano.forEach(p => {

      const hasilId =
        String(p.hasil_suara_id);

      /*
       * Karena sudah ORDER id DESC,
       * hanya ambil record pertama.
       */
      if (!planoMap[hasilId]) {
        planoMap[hasilId] = p;
      }
    });


    /*
     * =========================================================
     * 6. ENRICH HASIL SUARA
     * =========================================================
     */

    const enrichedData =
      safeHasil.map(item => {

        const kKec =
          String(item.kecamatan || '')
            .toUpperCase()
            .trim();

        const kDesa =
          String(item.desa || '')
            .toUpperCase()
            .trim();

        const kTps =
          String(item.tps || '')
            .toUpperCase()
            .trim();

        const key =
          `${kKec}_${kDesa}_${kTps}`;

        const info =
          masterMap[key] || {
            jumlah_calon: 2,
            total_dpt: 0
          };


        const plano =
          planoMap[String(item.id)] || null;


        return {

          ...item,

          jumlah_calon:
            info.jumlah_calon,

          total_dpt:
            Number(
              item.total_dpt ??
              info.total_dpt ??
              0
            ),


          /*
           * ============================================
           * DATA PLANO TERBARU
           * ============================================
           */

          plano_upload_id:
            plano?.id ?? null,

          google_drive_url:
            plano?.google_drive_url ??
            item.google_drive_url ??
            null,

          ocr_status:
            plano?.ocr_status ??
            null,

          ocr_engine:
            plano?.ocr_engine ??
            null,

          ocr_calon_01:
            plano?.ocr_calon_01 ?? null,

          ocr_calon_02:
            plano?.ocr_calon_02 ?? null,

          ocr_calon_03:
            plano?.ocr_calon_03 ?? null,

          ocr_calon_04:
            plano?.ocr_calon_04 ?? null,

          ocr_calon_05:
            plano?.ocr_calon_05 ?? null,

          ocr_tidak_sah:
            plano?.ocr_tidak_sah ?? null,

          ocr_total_suara:
            plano?.ocr_total_suara ?? null,

          ocr_confidence:
            plano?.ocr_confidence ?? null,

          ocr_processed_at:
            plano?.ocr_processed_at ?? null,

          ocr_error:
            plano?.ocr_error ?? null
        };
      });


    /*
     * =========================================================
     * 7. RESPONSE
     * =========================================================
     */

    return res.status(200).json({
      ok: true,

      total_tps:
        safeMaster.length,

      master_desa:
        safeMaster,

      data:
        enrichedData
    });


  } catch (err) {

    console.error(
      'API GET-DATA ERROR:',
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
