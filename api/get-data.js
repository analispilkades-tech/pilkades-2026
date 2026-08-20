import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const SESSION_SECRET = process.env.SESSION_SECRET;


/*
=========================================================
HELPER
=========================================================
*/

function sha256(text) {

  return crypto
    .createHash('sha256')
    .update(text)
    .digest('hex');

}


function readCookie(req, name) {

  const cookie =
    req.headers.cookie || '';

  const match =
    cookie.match(
      new RegExp(
        `(?:^|;\\s*)${name}=([^;]+)`
      )
    );

  return match
    ? match[1]
    : null;

}


/*
=========================================================
AUTHENTICATION
=========================================================
*/

async function getAdminSession(req) {

  if (!SESSION_SECRET) {

    throw new Error(
      'SESSION_SECRET belum dikonfigurasi.'
    );

  }


  const token =
    readCookie(
      req,
      'admin_session'
    );


  if (!token) {

    return {
      authenticated: false,
      status: 401,
      error: 'Belum login.'
    };

  }


  const tokenHash =
    sha256(
      token + SESSION_SECRET
    );


  const {
    data: session,
    error
  } = await supabase

    .from('admin_sessions')

    .select(`
      id,
      admin_id,
      expires_at,
      admin_users (
        id,
        nrp,
        nama,
        role,
        kecamatan,
        aktif
      )
    `)

    .eq(
      'token_hash',
      tokenHash
    )

    .gt(
      'expires_at',
      new Date().toISOString()
    )

    .maybeSingle();


  if (error) {

    console.error(
      '[GET-DATA] SESSION ERROR:',
      error
    );

    return {
      authenticated: false,
      status: 500,
      error: 'Gagal memeriksa session.'
    };

  }


  if (
    !session ||
    !session.admin_users
  ) {

    return {
      authenticated: false,
      status: 401,
      error:
        'Session tidak valid atau sudah berakhir.'
    };

  }


  const admin =
    session.admin_users;


  if (!admin.aktif) {

    return {
      authenticated: false,
      status: 403,
      error:
        'Akun admin sudah dinonaktifkan.'
    };

  }


  /*
   * UPDATE LAST ACCESS
   */

  await supabase
    .from('admin_sessions')
    .update({
      last_access:
        new Date().toISOString()
    })
    .eq(
      'id',
      session.id
    );


  /*
   * AMBIL WILAYAH ADMIN
   */

  let kecamatan = [];


  if (
    admin.role === 'SUPERADMIN' ||
    admin.role === 'SUPER_ADMIN'
  ) {

    /*
     * SUPERADMIN = seluruh wilayah.
     */

    kecamatan = null;

  } else {

    const {
      data: akses,
      error: aksesError
    } = await supabase

      .from('admin_kecamatan')

      .select('kecamatan')

      .eq(
        'admin_id',
        admin.id
      );


    if (aksesError) {

      console.error(
        '[GET-DATA] AKSES KECAMATAN ERROR:',
        aksesError
      );

      return {
        authenticated: false,
        status: 500,
        error:
          'Gagal mengambil hak akses kecamatan.'
      };

    }


    kecamatan =
      (akses || [])
        .map(item =>
          String(
            item.kecamatan || ''
          )
            .trim()
            .toUpperCase()
        )
        .filter(Boolean);


    /*
     * ADMIN BIASA TANPA WILAYAH
     * TIDAK BOLEH MELIHAT DATA.
     */

    if (kecamatan.length === 0) {

      return {
        authenticated: false,
        status: 403,
        error:
          'Admin belum memiliki wilayah akses.'
      };

    }

  }


  return {

    authenticated: true,

    session,

    admin,

    kecamatan

  };

}


/*
=========================================================
MAIN HANDLER
=========================================================
*/

export default async function handler(req, res) {

  /*
   * =====================================================
   * CORS
   * =====================================================
   *
   * Catatan:
   * Untuk endpoint yang memakai cookie authentication,
   * kita tidak mengandalkan CORS sebagai security.
   *
   * Session tetap diverifikasi server-side.
   */

  res.setHeader(
    'Access-Control-Allow-Origin',
    '*'
  );

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type'
  );


  if (req.method === 'OPTIONS') {

    return res
      .status(200)
      .end();

  }


  if (req.method !== 'GET') {

    return res
      .status(405)
      .json({
        ok: false,
        error: 'Method not allowed'
      });

  }


  try {

    /*
    =======================================================
    1. AUTHENTICATION
    =======================================================
    */

    const auth =
      await getAdminSession(req);


    if (!auth.authenticated) {

      return res
        .status(
          auth.status || 401
        )
        .json({

          ok: false,

          error:
            auth.error ||
            'Belum login.'

        });

    }


    const {
      admin,
      kecamatan
    } = auth;


    console.log(
      '[GET-DATA] ADMIN:',
      admin.nrp,
      admin.role,
      'WILAYAH:',
      kecamatan === null
        ? 'SEMUA'
        : kecamatan
    );


    /*
    =======================================================
    2. HASIL SUARA / LIVE COUNT
    =======================================================
    */

    let hasilQuery =
      supabase
        .from('hasil_suara')
        .select('*')
        .order(
          'id',
          {
            ascending: false
          }
        );


    /*
    -------------------------------------------------------
    FILTER WILAYAH
    -------------------------------------------------------
    */

    if (kecamatan !== null) {

      hasilQuery =
        hasilQuery.in(
          'kecamatan',
          kecamatan
        );

    }


    const {
      data: hasilData,
      error: hasilErr
    } = await hasilQuery;


    if (hasilErr) {

      console.error(
        '[GET-DATA] HASIL SUARA ERROR:',
        hasilErr
      );

      return res
        .status(500)
        .json({

          ok: false,

          error:
            'Gagal mengambil data hasil suara.'

        });

    }


    /*
    =======================================================
    3. MASTER DESA
    =======================================================
    */

    let masterQuery =
      supabase
        .from('master_desa')
        .select('*');


    /*
    -------------------------------------------------------
    FILTER MASTER DESA
    -------------------------------------------------------
    */

    if (kecamatan !== null) {

      masterQuery =
        masterQuery.in(
          'kecamatan',
          kecamatan
        );

    }


    const {
      data: masterData,
      error: masterErr
    } = await masterQuery;


    if (masterErr) {

      console.error(
        '[GET-DATA] MASTER DESA ERROR:',
        masterErr
      );

      return res
        .status(500)
        .json({

          ok: false,

          error:
            'Gagal mengambil master desa.'

        });

    }


    /*
    =======================================================
    4. PLANO TERBARU
    =======================================================
    */

    let planoQuery =
      supabase

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

        .order(
          'id',
          {
            ascending: false
          }
        );


    /*
     * Untuk plano kita tidak bisa langsung
     * filter berdasarkan kecamatan karena tabel
     * plano_uploads memakai hasil_suara_id.
     *
     * Jadi kita ambil plano dan nanti hanya
     * mempertahankan yang hasil_suara_id-nya
     * memang termasuk hasilData yang sudah difilter.
     */

    const {
      data: planoData,
      error: planoErr
    } = await planoQuery;


    if (planoErr) {

      console.error(
        '[GET-DATA] PLANO ERROR:',
        planoErr
      );

      return res
        .status(500)
        .json({

          ok: false,

          error:
            'Gagal mengambil data plano.'

        });

    }


    /*
    =======================================================
    5. SAFE ARRAY
    =======================================================
    */

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
    =======================================================
    6. BUAT SET HASIL SUARA YANG BOLEH DIAKSES
    =======================================================
    */

    const allowedHasilIds =
      new Set(
        safeHasil.map(
          item =>
            String(item.id)
        )
      );


    /*
    =======================================================
    7. FILTER PLANO
    =======================================================
    */

    const filteredPlano =
      safePlano.filter(
        plano =>
          allowedHasilIds.has(
            String(
              plano.hasil_suara_id
            )
          )
      );


    /*
    =======================================================
    8. MAP MASTER
    =======================================================
    */

    const masterMap = {};


    safeMaster.forEach(m => {

      const kKec =
        String(
          m.kecamatan || ''
        )
          .toUpperCase()
          .trim();


      const kDesa =
        String(
          m.desa || ''
        )
          .toUpperCase()
          .trim();


      const kTps =
        String(
          m.tps || ''
        )
          .toUpperCase()
          .trim();


      const key =
        `${kKec}_${kDesa}_${kTps}`;


      masterMap[key] = {

        jumlah_calon:
          Number(
            m.jumlah_calon || 2
          ),

        total_dpt:
          Number(
            m.total_dpt ??
            m.dpt ??
            0
          )

      };

    });


    /*
    =======================================================
    9. MAP PLANO TERBARU
    =======================================================
    */

    const planoMap = {};


    filteredPlano.forEach(p => {

      const hasilId =
        String(
          p.hasil_suara_id
        );


      /*
       * Karena sudah ORDER id DESC,
       * record pertama adalah yang terbaru.
       */

      if (!planoMap[hasilId]) {

        planoMap[hasilId] =
          p;

      }

    });


    /*
    =======================================================
    10. ENRICH HASIL SUARA
    =======================================================
    */

    const enrichedData =
      safeHasil.map(item => {

        const kKec =
          String(
            item.kecamatan || ''
          )
            .toUpperCase()
            .trim();


        const kDesa =
          String(
            item.desa || ''
          )
            .toUpperCase()
            .trim();


        const kTps =
          String(
            item.tps || ''
          )
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
          planoMap[
            String(item.id)
          ] || null;


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
          ================================================
          PLANO TERBARU
          ================================================
          */

          plano_upload_id:
            plano?.id ??
            null,


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
            plano?.ocr_calon_01 ??
            null,


          ocr_calon_02:
            plano?.ocr_calon_02 ??
            null,


          ocr_calon_03:
            plano?.ocr_calon_03 ??
            null,


          ocr_calon_04:
            plano?.ocr_calon_04 ??
            null,


          ocr_calon_05:
            plano?.ocr_calon_05 ??
            null,


          ocr_tidak_sah:
            plano?.ocr_tidak_sah ??
            null,


          ocr_total_suara:
            plano?.ocr_total_suara ??
            null,


          ocr_confidence:
            plano?.ocr_confidence ??
            null,


          ocr_processed_at:
            plano?.ocr_processed_at ??
            null,


          ocr_error:
            plano?.ocr_error ??
            null

        };

      });


    /*
    =======================================================
    11. RESPONSE
    =======================================================
    */

    return res
      .status(200)
      .json({

        ok: true,

        admin: {

          id:
            admin.id,

          nrp:
            admin.nrp,

          nama:
            admin.nama,

          role:
            admin.role,

          kecamatan:
            kecamatan === null
              ? 'ALL'
              : kecamatan

        },

        total_tps:
          safeMaster.length,

        master_desa:
          safeMaster,

        data:
          enrichedData

      });


  } catch (err) {

    console.error(
      '[GET-DATA] FATAL ERROR:',
      err
    );

    return res
      .status(500)
      .json({

        ok: false,

        error:
          err?.message ||
          'Server error'

      });

  }

}