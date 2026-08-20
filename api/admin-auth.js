import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const SESSION_SECRET = process.env.SESSION_SECRET;

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

export default async function handler(req, res) {

  /*
  =========================================================
  CORS
  =========================================================
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
    1. CEK SESSION SECRET
    =======================================================
    */

    if (!SESSION_SECRET) {

      console.error(
        '[ADMIN AUTH] SESSION_SECRET belum diset.'
      );

      return res
        .status(500)
        .json({
          ok: false,
          error: 'Konfigurasi session server belum tersedia.'
        });

    }


    /*
    =======================================================
    2. AMBIL COOKIE
    =======================================================
    */

    const token =
      readCookie(
        req,
        'admin_session'
      );


    if (!token) {

      return res
        .status(401)
        .json({
          ok: false,
          error: 'Belum login.'
        });

    }


    /*
    =======================================================
    3. HASH TOKEN
    =======================================================
    */

    const tokenHash =
      sha256(
        token + SESSION_SECRET
      );


    /*
    =======================================================
    4. CARI SESSION
    =======================================================
    */

    const {
      data: session,
      error: sessionError
    } = await supabase

      .from('admin_sessions')

      .select(`
        id,
        admin_id,
        expires_at,
        created_at,
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


    if (sessionError) {

      console.error(
        '[ADMIN AUTH] SESSION ERROR:',
        sessionError
      );

      return res
        .status(500)
        .json({
          ok: false,
          error: 'Gagal memeriksa session.'
        });

    }


    /*
    =======================================================
    5. SESSION TIDAK VALID
    =======================================================
    */

    if (
      !session ||
      !session.admin_users
    ) {

      return res
        .status(401)
        .json({
          ok: false,
          error: 'Session tidak valid atau sudah berakhir.'
        });

    }


    const admin =
      session.admin_users;


    /*
    =======================================================
    6. CEK AKUN AKTIF
    =======================================================
    */

    if (!admin.aktif) {

      return res
        .status(403)
        .json({
          ok: false,
          error: 'Akun admin sudah dinonaktifkan.'
        });

    }


    /*
    =======================================================
    7. AMBIL HAK AKSES KECAMATAN
    =======================================================
    */

    let kecamatan = [];


    /*
    -------------------------------------------------------
    SUPERADMIN
    -------------------------------------------------------
    */

    if (
      admin.role === 'SUPERADMIN' ||
      admin.role === 'SUPER_ADMIN'
    ) {

      /*
       * SUPERADMIN tidak dibatasi oleh
       * tabel admin_kecamatan.
       *
       * Daftar kecamatan akan diambil
       * dari master_desa pada get-data.
       */

      kecamatan = [];

    }


    /*
    -------------------------------------------------------
    ADMIN POLSEK / ADMIN KECAMATAN
    -------------------------------------------------------
    */

    else {

      const {
        data: aksesKecamatan,
        error: aksesError
      } = await supabase

        .from('admin_kecamatan')

        .select(`
          id,
          kecamatan
        `)

        .eq(
          'admin_id',
          admin.id
        );


      if (aksesError) {

        console.error(
          '[ADMIN AUTH] AKSES KECAMATAN ERROR:',
          aksesError
        );

        return res
          .status(500)
          .json({
            ok: false,
            error:
              'Gagal mengambil hak akses kecamatan.'
          });

      }


      kecamatan =
        (aksesKecamatan || [])
          .map(item =>
            String(
              item.kecamatan || ''
            )
              .trim()
              .toUpperCase()
          )
          .filter(Boolean);

    }


    /*
    =======================================================
    8. UPDATE LAST ACCESS
    =======================================================
    */

    const { error: accessError } =
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


    if (accessError) {

      console.error(
        '[ADMIN AUTH] UPDATE LAST ACCESS ERROR:',
        accessError
      );

      /*
       * Tidak menggagalkan login.
       */

    }


    /*
    =======================================================
    9. RESPONSE
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

          aktif:
            admin.aktif,

          /*
           * Untuk SUPERADMIN:
           * [] berarti seluruh wilayah.
           *
           * Untuk ADMIN_POLSEK:
           * berisi daftar kecamatan yang diberikan.
           */

          kecamatan

        }

      });


  } catch (err) {

    console.error(
      '[ADMIN AUTH] FATAL ERROR:',
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