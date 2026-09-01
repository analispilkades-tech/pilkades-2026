import { supabase } from '../lib/supabase.js';
import { readCookie, requireAdmin } from '../lib/admin-session.js';

function securityHeaders(res, isAuthenticated = false) {
  // Public viewers may use short CDN caching. Authenticated admin responses
  // are private because their contents are restricted by role/kecamatan.
  res.setHeader(
    'Cache-Control',
    isAuthenticated ? 'private, no-store' : 'public, s-maxage=3, stale-while-revalidate=5'
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

export default async function handler(req, res) {
  const hasSessionCookie = Boolean(readCookie(req));
  securityHeaders(res, hasSessionCookie);
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    // Public request: return the normal public livecount.
    // Admin request: require a valid session and restrict data server-side.
    let auth = null;
    if (hasSessionCookie) {
      auth = await requireAdmin(req);
      if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
    }

    const role = String(auth?.admin?.role || '').trim().toUpperCase();
    const isSuperadmin = role === 'SUPERADMIN' || role === 'SUPER_ADMIN';
    const allowedKecamatan = isSuperadmin ? null : (auth?.allowedKecamatan || []);

    let masterQuery = supabase
      .from('master_desa')
      .select('kecamatan,desa,tps,jumlah_calon,total_dpt')
      .order('kecamatan')
      .order('desa')
      .order('tps');

    let dataQuery = supabase
      .from('hasil_suara')
      .select(
        'id,kecamatan,desa,tps,nrp_saksi,nama_saksi,suara_calon_01,suara_calon_02,suara_calon_03,suara_calon_04,suara_calon_05,suara_tidak_sah,total_suara_masuk,status_verifikasi,timestamp'
      )
      .order('id', { ascending: false });

    if (Array.isArray(allowedKecamatan)) {
      if (!allowedKecamatan.length) {
        return res.status(403).json({ ok: false, error: 'Admin belum memiliki wilayah akses.' });
      }
      masterQuery = masterQuery.in('kecamatan', allowedKecamatan);
      dataQuery = dataQuery.in('kecamatan', allowedKecamatan);
    }

    const [{ data: master, error: masterError }, { data, error }] = await Promise.all([
      masterQuery,
      dataQuery
    ]);

    if (masterError || error) {
      console.error('[LIVECOUNT] DATABASE ERROR:', masterError || error);
      return res.status(500).json({ ok: false, error: 'Gagal mengambil data live count.' });
    }

    return res.status(200).json({
      ok: true,
      master_desa: Array.isArray(master) ? master : [],
      data: Array.isArray(data) ? data : []
    });
  } catch (err) {
    console.error('[LIVECOUNT] FATAL ERROR:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
}
