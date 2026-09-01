import { supabase } from '../lib/supabase.js';

function securityHeaders(res) {
  // Public data is intentionally cacheable for a few seconds to reduce
  // database pressure when many viewers open the dashboard simultaneously.
  res.setHeader('Cache-Control', 'public, s-maxage=3, stale-while-revalidate=5');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

export default async function handler(req, res) {
  securityHeaders(res);
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const [{ data: master, error: masterError }, { data, error }] = await Promise.all([
      supabase.from('master_desa').select('kecamatan,desa,tps,jumlah_calon,total_dpt,dpt').order('kecamatan').order('desa').order('tps'),
      supabase.from('hasil_suara').select(
        'id,kecamatan,desa,tps,nrp_saksi,nama_saksi,suara_calon_01,suara_calon_02,suara_calon_03,suara_calon_04,suara_calon_05,suara_tidak_sah,total_suara_masuk,status_verifikasi,timestamp'
      ).order('id', { ascending: false })
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
