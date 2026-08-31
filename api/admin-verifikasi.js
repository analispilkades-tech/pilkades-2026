import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';


const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);


/*
=========================================================
KONFIGURASI
=========================================================
*/

const ACTIONS = [
  'SAHKAN_MANUAL',
  'SAHKAN_PLANO',
  'UBAH_DATA',
  'ROLLBACK_VERIFIKASI'
];


const MIN_OCR_CONFIDENCE = 40;


/*
---------------------------------------------------------
STATUS FINAL
---------------------------------------------------------

Setelah VERIFIED_BY_ADMIN:

SAHKAN_MANUAL  -> LOCK
SAHKAN_PLANO   -> LOCK
UBAH_DATA      -> LOCK

Satu-satunya jalan membuka kembali:

ROLLBACK_VERIFIKASI
---------------------------------------------------------
*/

const STATUS_FINAL =
  'VERIFIED_BY_ADMIN';


/*
---------------------------------------------------------
STATUS SETELAH ROLLBACK
---------------------------------------------------------
*/

const STATUS_ROLLBACK =
  'MEMERLUKAN VERIFIKASI ADMIN';


/*
---------------------------------------------------------
SECRET SESSION
---------------------------------------------------------
*/

const SESSION_SECRET =
  process.env.SESSION_SECRET;


/*
=========================================================
HELPER
=========================================================
*/


/*
---------------------------------------------------------
SHA256
---------------------------------------------------------
*/

function sha256(text) {

  return crypto
    .createHash('sha256')
    .update(text)
    .digest('hex');

}


/*
---------------------------------------------------------
READ COOKIE
---------------------------------------------------------
*/

function readCookie(req, name) {

  const cookie =
    req.headers.cookie || '';

  if (!cookie) {
    return null;
  }


  const parts =
    cookie.split(';');


  for (const part of parts) {

    const index =
      part.indexOf('=');


    if (index === -1) {
      continue;
    }


    const key =
      part
        .slice(0, index)
        .trim();


    const value =
      part
        .slice(index + 1)
        .trim();


    if (key === name) {

      try {

        return decodeURIComponent(value);

      } catch (_) {

        return value;

      }

    }

  }


  return null;

}


/*
---------------------------------------------------------
NUMBER NORMALIZER
---------------------------------------------------------
*/

function numberOrZero(value) {

  const n =
    Number(value);


  if (!Number.isFinite(n)) {

    return 0;

  }


  return Math.max(
    0,
    Math.floor(n)
  );

}


/*
---------------------------------------------------------
CALCULATE TOTAL
---------------------------------------------------------
*/

function calculateTotal(data) {

  return (

    numberOrZero(
      data.suara_calon_01
    ) +

    numberOrZero(
      data.suara_calon_02
    ) +

    numberOrZero(
      data.suara_calon_03
    ) +

    numberOrZero(
      data.suara_calon_04
    ) +

    numberOrZero(
      data.suara_calon_05
    ) +

    numberOrZero(
      data.suara_tidak_sah
    )

  );

}


/*
=========================================================
ADMIN SESSION AUTHENTICATION
=========================================================
*/

async function getAuthenticatedAdmin(req) {

  /*
  -------------------------------------------------------
  SESSION SECRET
  -------------------------------------------------------
  */

  if (!SESSION_SECRET) {

    console.error(
      '[ADMIN VERIFIKASI] SESSION_SECRET belum diset.'
    );


    return {

      error:
        'Konfigurasi autentikasi server belum lengkap.',

      status:
        500

    };

  }


  /*
  -------------------------------------------------------
  AMBIL COOKIE
  -------------------------------------------------------
  */

  const token =
    readCookie(
      req,
      'admin_session'
    );


  if (!token) {

    return {

      error:
        'Belum login.',

      status:
        401

    };

  }


  /*
  -------------------------------------------------------
  HASH TOKEN
  -------------------------------------------------------
  */

  const tokenHash =
    sha256(
      token +
      SESSION_SECRET
    );


  /*
  -------------------------------------------------------
  CARI SESSION
  -------------------------------------------------------
  */

  const {

    data: session,

    error

  } = await supabase

    .from('admin_sessions')

    .select(`
      id,
      admin_id,
      token_hash,
      expires_at,
      last_access,
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
      '[ADMIN VERIFIKASI] SESSION ERROR:',
      error
    );


    return {

      error:
        'Gagal memeriksa session admin.',

      status:
        500

    };

  }


  /*
  -------------------------------------------------------
  SESSION TIDAK VALID
  -------------------------------------------------------
  */

  if (
    !session ||
    !session.admin_users
  ) {

    return {

      error:
        'Session admin tidak valid atau sudah berakhir.',

      status:
        401

    };

  }


  const admin =
    session.admin_users;


  /*
  -------------------------------------------------------
  ADMIN TIDAK AKTIF
  -------------------------------------------------------
  */

  if (!admin.aktif) {

    return {

      error:
        'Akun admin sudah tidak aktif.',

      status:
        403

    };

  }


  /*
  -------------------------------------------------------
  UPDATE LAST ACCESS
  -------------------------------------------------------
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

    admin,

    session

  };

}


/*
=========================================================
ADMIN AUTHORIZATION
=========================================================
*/

function adminCanAccessKecamatan(
  admin,
  kecamatan
) {

  const role =
    String(
      admin?.role || ''
    )
      .trim()
      .toUpperCase();


  /*
  -------------------------------------------------------
  SUPERADMIN
  -------------------------------------------------------
  */

  if (
    role === 'SUPERADMIN' ||
    role === 'SUPER_ADMIN'
  ) {

    return true;

  }


  /*
  -------------------------------------------------------
  TARGET KECAMATAN
  -------------------------------------------------------
  */

  const target =
    String(
      kecamatan || ''
    )
      .trim()
      .toUpperCase();


  if (!target) {

    return false;

  }


  let allowed =
    admin?.kecamatan;


  /*
  -------------------------------------------------------
  DATABASE ARRAY
  -------------------------------------------------------
  */

  if (
    Array.isArray(allowed)
  ) {

    return allowed
      .map(
        x =>
          String(x)
            .trim()
            .toUpperCase()
      )
      .includes(
        target
      );

  }


  /*
  -------------------------------------------------------
  DATABASE STRING
  -------------------------------------------------------
  */

  if (
    typeof allowed === 'string'
  ) {

    const value =
      allowed.trim();


    /*
    JSON ARRAY
    */

    if (
      value.startsWith('[')
    ) {

      try {

        const parsed =
          JSON.parse(value);


        if (
          Array.isArray(parsed)
        ) {

          return parsed
            .map(
              x =>
                String(x)
                  .trim()
                  .toUpperCase()
            )
            .includes(
              target
            );

        }

      } catch (_) {

        /*
        Bukan JSON.
        Lanjut sebagai string biasa.
        */

      }

    }


    /*
    -----------------------------------------------------
    FORMAT:
    SAPURAN,KALIWIRO
    -----------------------------------------------------
    */

    const list =
      value
        .split(',')
        .map(
          x =>
            x
              .trim()
              .toUpperCase()
        )
        .filter(Boolean);


    return list.includes(
      target
    );

  }


  return false;

}


/*
=========================================================
AUDIT LOG
=========================================================
*/

async function logAktivitas({

  jenis_aksi,

  admin_nama = 'Admin',

  hasil_sebelum = null,

  hasil_sesudah = null,

  keterangan = '',

  rollback_reason = null

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
            `[Admin: ${admin_nama}] ${keterangan}`,

          rollback_reason:
            rollback_reason || null

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
  OPTIONS
  -------------------------------------------------------
  */

  if (
    req.method === 'OPTIONS'
  ) {

    return res
      .status(200)
      .end();

  }


  /*
  -------------------------------------------------------
  POST ONLY
  -------------------------------------------------------
  */

  if (
    req.method !== 'POST'
  ) {

    return res
      .status(405)
      .json({

        ok:
          false,

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
      await getAuthenticatedAdmin(
        req
      );


    if (auth.error) {

      return res
        .status(
          auth.status || 401
        )
        .json({

          ok:
            false,

          error:
            auth.error

        });

    }


    const admin =
      auth.admin;


    const adminNama =
      admin?.nama ||
      admin?.nrp ||
      'Admin';


    /*
    =======================================================
    2. REQUEST BODY
    =======================================================
    */

    const body =
      req.body || {};


    const id =
      body.id;


    const action =
      body.action;


    const data =
      body.data;


    const rollback_reason =
      body.rollback_reason;


    /*
    =======================================================
    3. VALIDASI ID
    =======================================================
    */

    if (!id) {

      return res
        .status(400)
        .json({

          ok:
            false,

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

          ok:
            false,

          error:
            `Aksi admin tidak valid. ` +
            `Aksi yang tersedia: ` +
            `${ACTIONS.join(', ')}`

        });

    }


    /*
    =======================================================
    5. AMBIL DATA HASIL SUARA
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
        '[ADMIN] DATA HASIL SUARA ERROR:',
        hasilError
      );


      return res
        .status(500)
        .json({

          ok:
            false,

          error:
            hasilError.message ||
            'Gagal mengambil data hasil suara.'

        });

    }


    if (!hasil) {

      return res
        .status(404)
        .json({

          ok:
            false,

          error:
            'Data hasil suara tidak ditemukan.'

        });

    }


    /*
    =======================================================
    6. AUTHORIZATION KECAMATAN
    =======================================================
    */

    if (
      !adminCanAccessKecamatan(
        admin,
        hasil.kecamatan
      )
    ) {

      console.warn(
        `[ADMIN AUTH] Akses ditolak. ` +
        `Admin=${admin.nrp} ` +
        `Kecamatan=${hasil.kecamatan}`
      );


      return res
        .status(403)
        .json({

          ok:
            false,

          code:
            'KECAMATAN_ACCESS_DENIED',

          error:
            'Anda tidak memiliki hak akses ' +
            'untuk memproses kecamatan ini.'

        });

    }


    /*
    =======================================================
    7. SNAPSHOT DATA SEBELUM
    =======================================================
    */

    const dataSebelum = {

      id:
        hasil.id,

      kecamatan:
        hasil.kecamatan,

      desa:
        hasil.desa,

      tps:
        hasil.tps,

      nrp_saksi:
        hasil.nrp_saksi,

      nama_saksi:
        hasil.nama_saksi,

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
    8. FINAL LOCK
    =======================================================
    */

    const sudahFinal =
      hasil.status_verifikasi ===
      STATUS_FINAL;


    /*
    -------------------------------------------------------
    DATA SUDAH FINAL
    -------------------------------------------------------
    */

    if (
      sudahFinal &&
      action !==
        'ROLLBACK_VERIFIKASI'
    ) {

      return res
        .status(409)
        .json({

          ok:
            false,

          code:
            'DATA_ALREADY_VERIFIED',

          error:
            'Data sudah diverifikasi dan dikunci. ' +
            'Aksi lain tidak dapat dilakukan sebelum ' +
            'rollback verifikasi.',

          status_verifikasi:
            hasil.status_verifikasi

        });

    }


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
            STATUS_FINAL

        })

        .eq(
          'id',
          id
        )

        .neq(
          'status_verifikasi',
          STATUS_FINAL
        )

        .select('*')

        .maybeSingle();


      if (updateError) {

        console.error(
          '[ADMIN] SAHKAN MANUAL ERROR:',
          updateError
        );


        return res
          .status(500)
          .json({

            ok:
              false,

            error:
              updateError.message

          });

      }


      if (!updated) {

        return res
          .status(409)
          .json({

            ok:
              false,

            code:
              'DATA_ALREADY_CHANGED',

            error:
              'Data tidak dapat disahkan karena ' +
              'statusnya sudah berubah atau sudah dikunci.'

          });

      }


      await logAktivitas({

        jenis_aksi:
          'ADMIN_SAHKAN_MANUAL',

        admin_nama:
          adminNama,

        hasil_sebelum:
          dataSebelum,

        hasil_sesudah:
          updated,

        keterangan:
          'Admin mengesahkan hasil input manual. ' +
          'Angka livecount tidak diubah.'

      });


      console.log(
        `[ADMIN] ${adminNama} ` +
        `(NRP ${admin.nrp}) ` +
        `mengesahkan INPUT MANUAL ` +
        `hasil_suara ID=${id}`
      );


      return res
        .status(200)
        .json({

          ok:
            true,

          message:
            'Hasil input manual berhasil disahkan admin.',

          status_verifikasi:
            STATUS_FINAL,

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

      /*
      -----------------------------------------------------
      AMBIL OCR TERBARU
      -----------------------------------------------------
      */

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

            ok:
              false,

            error:
              planoError.message

          });

      }


      if (!plano) {

        return res
          .status(404)
          .json({

            ok:
              false,

            error:
              'Hasil OCR plano belum tersedia.'

          });

      }


      /*
      -----------------------------------------------------
      CONFIDENCE
      -----------------------------------------------------
      */

      const confidence =
        Number(
          plano.ocr_confidence || 0
        );


      if (
        !Number.isFinite(
          confidence
        ) ||
        confidence <
          MIN_OCR_CONFIDENCE
      ) {

        return res
          .status(400)
          .json({

            ok:
              false,

            code:
              'OCR_CONFIDENCE_TOO_LOW',

            error:
              `Plano tidak dapat disahkan karena ` +
              `confidence OCR hanya ${confidence}. ` +
              `Minimum ${MIN_OCR_CONFIDENCE}. ` +
              `Gunakan "Ubah Data" atau ` +
              `"Sahkan Manual".`,

            confidence,

            minimum:
              MIN_OCR_CONFIDENCE

          });

      }


      /*
      -----------------------------------------------------
      DATA OCR
      -----------------------------------------------------
      */

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


      /*
      -----------------------------------------------------
      TOTAL OCR
      -----------------------------------------------------
      */

      const total =
        calculateTotal(
          ocrData
        );


      /*
      -----------------------------------------------------
      UPDATE
      -----------------------------------------------------
      */

      const {

        data: updated,

        error: updateError

      } = await supabase

        .from('hasil_suara')

        .update({

          suara_calon_01:
            ocrData.suara_calon_01,

          suara_calon_02:
            ocrData.suara_calon_02,

          suara_calon_03:
            ocrData.suara_calon_03,

          suara_calon_04:
            ocrData.suara_calon_04,

          suara_calon_05:
            ocrData.suara_calon_05,

          suara_tidak_sah:
            ocrData.suara_tidak_sah,

          total_suara_masuk:
            total,

          status_verifikasi:
            STATUS_FINAL

        })

        .eq(
          'id',
          id
        )

        .neq(
          'status_verifikasi',
          STATUS_FINAL
        )

        .select('*')

        .maybeSingle();


      if (updateError) {

        console.error(
          '[ADMIN] UPDATE PLANO ERROR:',
          updateError
        );


        return res
          .status(500)
          .json({

            ok:
              false,

            error:
              updateError.message

          });

      }


      if (!updated) {

        return res
          .status(409)
          .json({

            ok:
              false,

            code:
              'DATA_ALREADY_CHANGED',

            error:
              'Data tidak dapat disahkan karena ' +
              'sudah diverifikasi atau diubah admin lain.'

          });

      }


      await logAktivitas({

        jenis_aksi:
          'ADMIN_SAHKAN_PLANO',

        admin_nama:
          adminNama,

        hasil_sebelum:
          dataSebelum,

        hasil_sesudah:
          updated,

        keterangan:
          `Admin mengesahkan hasil plano/OCR. ` +
          `Confidence=${confidence}.`

      });


      console.log(
        `[ADMIN] ${adminNama} ` +
        `(NRP ${admin.nrp}) ` +
        `mengesahkan HASIL PLANO ` +
        `hasil_suara ID=${id}`
      );


      return res
        .status(200)
        .json({

          ok:
            true,

          message:
            'Hasil plano berhasil disahkan admin.',

          status_verifikasi:
            STATUS_FINAL,

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

      /*
      -----------------------------------------------------
      VALIDASI DATA
      -----------------------------------------------------
      */

      if (
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data)
      ) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              'Data perubahan wajib dikirim.'

          });

      }


      /*
      -----------------------------------------------------
      NORMALISASI
      -----------------------------------------------------
      */

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


      /*
      -----------------------------------------------------
      TOTAL SERVER-SIDE
      -----------------------------------------------------
      */

      const total =
        calculateTotal(
          newData
        );


      /*
      -----------------------------------------------------
      UPDATE DENGAN LOCK
      -----------------------------------------------------
      */

      const {

        data: updated,

        error: updateError

      } = await supabase

        .from('hasil_suara')

        .update({

          suara_calon_01:
            newData.suara_calon_01,

          suara_calon_02:
            newData.suara_calon_02,

          suara_calon_03:
            newData.suara_calon_03,

          suara_calon_04:
            newData.suara_calon_04,

          suara_calon_05:
            newData.suara_calon_05,

          suara_tidak_sah:
            newData.suara_tidak_sah,

          total_suara_masuk:
            total,

          status_verifikasi:
            STATUS_FINAL

        })

        .eq(
          'id',
          id
        )

        .neq(
          'status_verifikasi',
          STATUS_FINAL
        )

        .select('*')

        .maybeSingle();


      if (updateError) {

        console.error(
          '[ADMIN] UBAH DATA ERROR:',
          updateError
        );


        return res
          .status(500)
          .json({

            ok:
              false,

            error:
              updateError.message

          });

      }


      if (!updated) {

        return res
          .status(409)
          .json({

            ok:
              false,

            code:
              'DATA_ALREADY_CHANGED',

            error:
              'Data tidak dapat diubah karena ' +
              'sudah diverifikasi atau diproses admin lain.'

          });

      }


      await logAktivitas({

        jenis_aksi:
          'ADMIN_UBAH_DATA',

        admin_nama:
          adminNama,

        hasil_sebelum:
          dataSebelum,

        hasil_sesudah:
          updated,

        keterangan:
          'Admin melakukan koreksi angka hasil suara ' +
          'secara manual dan langsung mengesahkan data.'

      });


      console.log(
        `[ADMIN] ${adminNama} ` +
        `(NRP ${admin.nrp}) ` +
        `MENGUBAH DATA ` +
        `hasil_suara ID=${id}`
      );


      return res
        .status(200)
        .json({

          ok:
            true,

          message:
            'Data hasil suara berhasil diubah ' +
            'dan disahkan admin.',

          status_verifikasi:
            STATUS_FINAL,

          data:
            updated

        });

    }


    /*
    =======================================================
    ACTION 4
    ROLLBACK VERIFIKASI
    =======================================================
    */

    if (
      action ===
      'ROLLBACK_VERIFIKASI'
    ) {

      /*
      -----------------------------------------------------
      VALIDASI ALASAN
      -----------------------------------------------------
      */

      const alasanRollback =
        String(
          rollback_reason || ''
        ).trim();


      if (!alasanRollback) {

        return res
          .status(400)
          .json({

            ok:
              false,

            code:
              'ROLLBACK_REASON_REQUIRED',

            error:
              'Alasan rollback wajib diisi.'

          });

      }


      if (
        alasanRollback.length < 5
      ) {

        return res
          .status(400)
          .json({

            ok:
              false,

            code:
              'ROLLBACK_REASON_TOO_SHORT',

            error:
              'Alasan rollback minimal 5 karakter.'

          });

      }


      if (
        alasanRollback.length > 1000
      ) {

        return res
          .status(400)
          .json({

            ok:
              false,

            code:
              'ROLLBACK_REASON_TOO_LONG',

            error:
              'Alasan rollback maksimal 1000 karakter.'

          });

      }


      /*
      -----------------------------------------------------
      HARUS FINAL
      -----------------------------------------------------
      */

      if (
        hasil.status_verifikasi !==
        STATUS_FINAL
      ) {

        return res
          .status(409)
          .json({

            ok:
              false,

            code:
              'DATA_NOT_VERIFIED',

            error:
              'Data belum berstatus VERIFIED_BY_ADMIN, ' +
              'sehingga tidak perlu di-rollback.',

            status_verifikasi:
              hasil.status_verifikasi

          });

      }


      /*
      -----------------------------------------------------
      ROLLBACK DENGAN LOCK
      -----------------------------------------------------
      */

      const {

        data: updated,

        error: updateError

      } = await supabase

        .from('hasil_suara')

        .update({

          status_verifikasi:
            STATUS_ROLLBACK

        })

        .eq(
          'id',
          id
        )

        .eq(
          'status_verifikasi',
          STATUS_FINAL
        )

        .select('*')

        .maybeSingle();


      if (updateError) {

        console.error(
          '[ADMIN] ROLLBACK ERROR:',
          updateError
        );


        return res
          .status(500)
          .json({

            ok:
              false,

            error:
              updateError.message

          });

      }


      if (!updated) {

        return res
          .status(409)
          .json({

            ok:
              false,

            code:
              'ROLLBACK_FAILED',

            error:
              'Rollback gagal karena data sudah berubah ' +
              'atau sudah diproses admin lain.'

          });

      }


      /*
      -----------------------------------------------------
      AUDIT LOG
      -----------------------------------------------------
      */

      await logAktivitas({

        jenis_aksi:
          'ADMIN_ROLLBACK_VERIFIKASI',

        admin_nama:
          adminNama,

        hasil_sebelum:
          dataSebelum,

        hasil_sesudah:
          updated,

        rollback_reason:
          alasanRollback,

        keterangan:
          'Admin melakukan rollback verifikasi dan ' +
          'membuka kembali data untuk audit/review.'

      });


      console.log(

        `[ADMIN] ${adminNama} ` +
        `(NRP ${admin.nrp}) ` +
        `ROLLBACK VERIFIKASI ` +
        `hasil_suara ID=${id} ` +
        `alasan="${alasanRollback}"`

      );


      /*
      -----------------------------------------------------
      RESPONSE
      -----------------------------------------------------
      */

      return res
        .status(200)
        .json({

          ok:
            true,

          message:
            'Rollback verifikasi berhasil. ' +
            'Data kembali ke antrean verifikasi admin.',

          status_verifikasi:
            STATUS_ROLLBACK,

          rollback_reason:
            alasanRollback,

          data:
            updated

        });

    }


    /*
    =======================================================
    FALLBACK
    =======================================================
    */

    return res
      .status(400)
      .json({

        ok:
          false,

        error:
          'Aksi tidak dapat diproses.'

      });


  } catch (err) {

    console.error(
      '[ADMIN VERIFIKASI] ERROR:',
      err
    );


    return res
      .status(500)
      .json({

        ok:
          false,

        error:
          err?.message ||
          'Server error',

        type:
          err?.name ||
          'ServerError'

      });

  }

}