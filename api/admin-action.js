import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const SESSION_SECRET = process.env.SESSION_SECRET;

const ACTIONS = [
  'SAHKAN_MANUAL',
  'SAHKAN_PLANO',
  'UBAH_DATA',
  'RESET_VERIFIKASI'
];

const MIN_OCR_CONFIDENCE = 40;


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


function numberOrZero(value) {

  const n = Number(value);

  if (!Number.isFinite(n)) {
    return 0;
  }

  return Math.max(
    0,
    Math.floor(n)
  );

}


function calculateTotal(data) {

  return (
    numberOrZero(data.suara_calon_01) +
    numberOrZero(data.suara_calon_02) +
    numberOrZero(data.suara_calon_03) +
    numberOrZero(data.suara_calon_04) +
    numberOrZero(data.suara_calon_05) +
    numberOrZero(data.suara_tidak_sah)
  );

}


/*
=========================================================
AUTH SESSION
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
      '[ADMIN ACTION] SESSION ERROR:',
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
  -------------------------------------------------------
  AMBIL WILAYAH ADMIN
  -------------------------------------------------------
  */

  let kecamatan = null;


  /*
  SUPERADMIN
  */

  if (
    admin.role === 'SUPERADMIN' ||
    admin.role === 'SUPER_ADMIN'
  ) {

    /*
     * null = SEMUA WILAYAH
     */

    kecamatan = null;

  }


  /*
  ADMIN BIASA
  */

  else {

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
        '[ADMIN ACTION] AKSES ERROR:',
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


    if (kecamatan.length === 0) {

      return {
        authenticated: false,
        status: 403,
        error:
          'Admin belum memiliki wilayah akses.'
      };

    }

  }


  /*
  UPDATE LAST ACCESS
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


  return {

    authenticated: true,

    session,

    admin,

    kecamatan

  };

}


/*
=========================================================
CEK HAK AKSES DATA
=========================================================
*/

function canAccessKecamatan(
  kecamatan,
  allowedKecamatan
) {

  /*
   * SUPERADMIN
   */

  if (
    allowedKecamatan === null
  ) {

    return true;

  }


  const target =
    String(
      kecamatan || ''
    )
      .trim()
      .toUpperCase();


  return allowedKecamatan.includes(
    target
  );

}


/*
=========================================================
AUDIT LOG
=========================================================
*/

async function logAktivitas({

  jenis_aksi,

  admin_nama,

  hasil_sebelum = null,

  hasil_sesudah = null,

  keterangan = ''

}) {

  try {

    const { error } =
      await supabase
        .from('log_aktivitas')
        .insert({

          sumber_aksi:
            'ADMIN_PANEL',

          jenis_aksi,

          nrp_saksi:
            hasil_sebelum?.nrp_saksi ||
            hasil_sesudah?.nrp_saksi ||
            null,

          nama_saksi:
            hasil_sebelum?.nama_saksi ||
            hasil_sesudah?.nama_saksi ||
            null,

          kecamatan:
            hasil_sebelum?.kecamatan ||
            hasil_sesudah?.kecamatan ||
            null,

          desa:
            hasil_sebelum?.desa ||
            hasil_sesudah?.desa ||
            null,

          tps:
            hasil_sebelum?.tps ||
            hasil_sesudah?.tps ||
            null,

          data_sebelum:
            hasil_sebelum,

          data_sesudah:
            hasil_sesudah,

          keterangan:
            `[Admin: ${
              admin_nama || 'Admin'
            }] ${keterangan}`

        });


    if (error) {

      console.error(
        '[ADMIN] LOG AKTIVITAS ERROR:',
        error
      );

    }

  } catch (error) {

    console.error(
      '[ADMIN] LOG AKTIVITAS EXCEPTION:',
      error
    );

  }

}


/*
=========================================================
MAIN HANDLER
=========================================================
*/

export default async function handler(
  req,
  res
) {

  /*
  -------------------------------------------------------
  CORS
  -------------------------------------------------------
  */

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


  if (
    req.method === 'OPTIONS'
  ) {

    return res
      .status(200)
      .end();

  }


  if (
    req.method !== 'POST'
  ) {

    return res
      .status(405)
      .json({

        ok: false,

        error:
          'Method not allowed'

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


    if (
      !auth.authenticated
    ) {

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
      kecamatan: allowedKecamatan
    } = auth;


    /*
    =======================================================
    2. BODY
    =======================================================
    */

    const body =
      typeof req.body === 'string'
        ? JSON.parse(req.body)
        : (
            req.body ||
            {}
          );


    const {
      id,
      action,
      data
    } = body;


    /*
    =======================================================
    3. VALIDASI ID
    =======================================================
    */

    if (!id) {

      return res
        .status(400)
        .json({

          ok: false,

          error:
            'ID hasil_suara wajib diisi.'

        });

    }


    /*
    =======================================================
    4. VALIDASI ACTION
    =======================================================
    */

    if (
      !ACTIONS.includes(action)
    ) {

      return res
        .status(400)
        .json({

          ok: false,

          error:
            `Aksi admin tidak valid. ` +
            `Aksi tersedia: ` +
            `${ACTIONS.join(', ')}`

        });

    }


    /*
    =======================================================
    5. AMBIL HASIL SUARA
    =======================================================
    */

    const {
      data: hasil,
      error: hasilError
    } = await supabase

      .from('hasil_suara')

      .select('*')

      .eq(
        'id',
        id
      )

      .maybeSingle();


    if (hasilError) {

      console.error(
        '[ADMIN ACTION] DATA ERROR:',
        hasilError
      );

      return res
        .status(500)
        .json({

          ok: false,

          error:
            'Gagal mengambil data hasil suara.'

        });

    }


    if (!hasil) {

      return res
        .status(404)
        .json({

          ok: false,

          error:
            'Data hasil suara tidak ditemukan.'

        });

    }


    /*
    =======================================================
    6. CEK WILAYAH
    =======================================================
    */

    if (
      !canAccessKecamatan(
        hasil.kecamatan,
        allowedKecamatan
      )
    ) {

      console.warn(
        '[ADMIN ACTION] AKSES DITOLAK:',
        {
          admin:
            admin.nrp,

          role:
            admin.role,

          kecamatan:
            hasil.kecamatan
        }
      );


      return res
        .status(403)
        .json({

          ok: false,

          error:
            'Anda tidak memiliki hak akses untuk kecamatan ini.'

        });

    }


    /*
    =======================================================
    7. SNAPSHOT SEBELUM
    =======================================================
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
    =======================================================
    ACTION 1
    SAHKAN MANUAL
    =======================================================
    */

    if (
      action ===
      'SAHKAN_MANUAL'
    ) {

      const {
        data: updated,
        error: updateError
      } = await supabase

        .from('hasil_suara')

        .update({

          status_verifikasi:
            'VERIFIED_BY_ADMIN'

        })

        .eq(
          'id',
          id
        )

        .select('*')

        .single();


      if (updateError) {

        console.error(
          '[ADMIN] SAHKAN MANUAL ERROR:',
          updateError
        );

        return res
          .status(500)
          .json({

            ok: false,

            error:
              updateError.message

          });

      }


      await logAktivitas({

        jenis_aksi:
          'ADMIN_SAHKAN_MANUAL',

        admin_nama:
          admin.nama,

        hasil_sebelum:
          dataSebelum,

        hasil_sesudah:
          updated,

        keterangan:
          'Admin mengesahkan hasil input manual. Angka livecount tidak diubah.'

      });


      return res
        .status(200)
        .json({

          ok: true,

          message:
            'Hasil input manual berhasil disahkan admin.',

          status_verifikasi:
            'VERIFIED_BY_ADMIN',

          data:
            updated

        });

    }


    /*
    =======================================================
    ACTION 2
    SAHKAN PLANO
    =======================================================
    */

    if (
      action ===
      'SAHKAN_PLANO'
    ) {

      const {
        data: plano,
        error: planoError
      } = await supabase

        .from('plano_uploads')

        .select('*')

        .eq(
          'hasil_suara_id',
          id
        )

        .eq(
          'ocr_status',
          'COMPLETED'
        )

        .order(
          'created_at',
          {
            ascending: false
          }
        )

        .limit(1)

        .maybeSingle();


      if (planoError) {

        console.error(
          '[ADMIN] AMBIL PLANO ERROR:',
          planoError
        );

        return res
          .status(500)
          .json({

            ok: false,

            error:
              planoError.message

          });

      }


      if (!plano) {

        return res
          .status(404)
          .json({

            ok: false,

            error:
              'Hasil OCR plano belum tersedia.'

          });

      }


      const confidence =
        Number(
          plano.ocr_confidence || 0
        );


      if (
        !Number.isFinite(confidence) ||
        confidence <
          MIN_OCR_CONFIDENCE
      ) {

        return res
          .status(400)
          .json({

            ok: false,

            error:
              `Plano tidak dapat disahkan karena ` +
              `confidence OCR hanya ${confidence}. ` +
              `Minimum ${MIN_OCR_CONFIDENCE}.`,

            code:
              'OCR_CONFIDENCE_TOO_LOW',

            confidence,

            minimum:
              MIN_OCR_CONFIDENCE

          });

      }


      const ocrData = {

        suara_calon_01:
          numberOrZero(
            plano.ocr_calon_01
          ),

        suara_calon_02:
          numberOrZero(
            plano.ocr_calon_02
          ),

        suara_calon_03:
          numberOrZero(
            plano.ocr_calon_03
          ),

        suara_calon_04:
          numberOrZero(
            plano.ocr_calon_04
          ),

        suara_calon_05:
          numberOrZero(
            plano.ocr_calon_05
          ),

        suara_tidak_sah:
          numberOrZero(
            plano.ocr_tidak_sah
          )

      };


      const total =
        calculateTotal(
          ocrData
        );


      const {
        data: updated,
        error: updateError
      } = await supabase

        .from('hasil_suara')

        .update({

          ...ocrData,

          total_suara_masuk:
            total,

          status_verifikasi:
            'VERIFIED_BY_ADMIN'

        })

        .eq(
          'id',
          id
        )

        .select('*')

        .single();


      if (updateError) {

        console.error(
          '[ADMIN] UPDATE PLANO ERROR:',
          updateError
        );

        return res
          .status(500)
          .json({

            ok: false,

            error:
              updateError.message

          });

      }


      await logAktivitas({

        jenis_aksi:
          'ADMIN_SAHKAN_PLANO',

        admin_nama:
          admin.nama,

        hasil_sebelum:
          dataSebelum,

        hasil_sesudah:
          updated,

        keterangan:
          `Admin mengesahkan hasil plano/OCR. Confidence=${confidence}.`

      });


      return res
        .status(200)
        .json({

          ok: true,

          message:
            'Hasil plano berhasil disahkan admin.',

          status_verifikasi:
            'VERIFIED_BY_ADMIN',

          confidence,

          applied:
            ocrData,

          total,

          data:
            updated

        });

    }


    /*
    =======================================================
    ACTION 3
    UBAH DATA
    =======================================================
    */

    if (
      action ===
      'UBAH_DATA'
    ) {

      if (
        !data ||
        typeof data !== 'object'
      ) {

        return res
          .status(400)
          .json({

            ok: false,

            error:
              'Data perubahan wajib dikirim.'

          });

      }


      const newData = {

        suara_calon_01:
          numberOrZero(
            data.suara_calon_01
          ),

        suara_calon_02:
          numberOrZero(
            data.suara_calon_02
          ),

        suara_calon_03:
          numberOrZero(
            data.suara_calon_03
          ),

        suara_calon_04:
          numberOrZero(
            data.suara_calon_04
          ),

        suara_calon_05:
          numberOrZero(
            data.suara_calon_05
          ),

        suara_tidak_sah:
          numberOrZero(
            data.suara_tidak_sah
          )

      };


      const total =
        calculateTotal(
          newData
        );


      const {
        data: updated,
        error: updateError
      } = await supabase

        .from('hasil_suara')

        .update({

          ...newData,

          total_suara_masuk:
            total,

          status_verifikasi:
            'VERIFIED_BY_ADMIN'

        })

        .eq(
          'id',
          id
        )

        .select('*')

        .single();


      if (updateError) {

        console.error(
          '[ADMIN] UBAH DATA ERROR:',
          updateError
        );

        return res
          .status(500)
          .json({

            ok: false,

            error:
              updateError.message

          });

      }


      await logAktivitas({

        jenis_aksi:
          'ADMIN_UBAH_DATA',

        admin_nama:
          admin.nama,

        hasil_sebelum:
          dataSebelum,

        hasil_sesudah:
          updated,

        keterangan:
          'Admin melakukan koreksi angka hasil suara secara manual.'

      });


      return res
        .status(200)
        .json({

          ok: true,

          message:
            'Data hasil suara berhasil diubah dan disahkan admin.',

          status_verifikasi:
            'VERIFIED_BY_ADMIN',

          data:
            updated

        });

    }


    /*
    =======================================================
    ACTION 4
    RESET VERIFIKASI
    =======================================================
    */

    if (
      action ===
      'RESET_VERIFIKASI'
    ) {

      const {
        data: updated,
        error: updateError
      } = await supabase

        .from('hasil_suara')

        .update({

          status_verifikasi:
            'MEMERLUKAN VERIFIKASI ADMIN'

        })

        .eq(
          'id',
          id
        )

        .select('*')

        .single();


      if (updateError) {

        console.error(
          '[ADMIN] RESET ERROR:',
          updateError
        );

        return res
          .status(500)
          .json({

            ok: false,

            error:
              updateError.message

          });

      }


      await logAktivitas({

        jenis_aksi:
          'ADMIN_RESET_VERIFIKASI',

        admin_nama:
          admin.nama,

        hasil_sebelum:
          dataSebelum,

        hasil_sesudah:
          updated,

        keterangan:
          'Admin membuka kembali data untuk audit/review.'

      });


      return res
        .status(200)
        .json({

          ok: true,

          message:
            'Status verifikasi berhasil dikembalikan ke antrean audit.',

          status_verifikasi:
            'MEMERLUKAN VERIFIKASI ADMIN',

          data:
            updated

        });

    }


    return res
      .status(400)
      .json({

        ok: false,

        error:
          'Aksi tidak dapat diproses.'

      });


  } catch (err) {

    console.error(
      '[ADMIN ACTION] FATAL ERROR:',
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