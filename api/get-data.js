import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // 1. Ambil data hasil_suara (paling baru di atas)
    const { data: hasilData, error: hasilErr } = await supabase
      .from('hasil_suara')
      .select('*')
      .order('id', { ascending: false });

    if (hasilErr) console.error('Error fetch hasil_suara:', hasilErr);

    // 2. Ambil master_desa secara aman (tidak crash jika terjadi kesalahan)
    const { data: masterData, error: masterErr } = await supabase
      .from('master_desa')
      .select('*');

    if (masterErr) console.error('Error fetch master_desa:', masterErr);

    const safeHasil = Array.isArray(hasilData) ? hasilData : [];
    const safeMaster = Array.isArray(masterData) ? masterData : [];

    // Peta jumlah_calon berdasarkan Kecamatan, Desa, TPS
    const masterMap = {};
    safeMaster.forEach(m => {
      const kKec = String(m.kecamatan || '').toUpperCase().trim();
      const kDesa = String(m.desa || '').toUpperCase().trim();
      const kTps = String(m.tps || '').toUpperCase().trim();
      const key = `${kKec}_${kDesa}_${kTps}`;
      masterMap[key] = Number(m.jumlah_calon || 2);
    });

    // Sisipkan jumlah_calon ke data hasil_suara
    const enrichedData = safeHasil.map(item => {
      const kKec = String(item.kecamatan || '').toUpperCase().trim();
      const kDesa = String(item.desa || '').toUpperCase().trim();
      const kTps = String(item.tps || '').toUpperCase().trim();
      const key = `${kKec}_${kDesa}_${kTps}`;
      return {
        ...item,
        jumlah_calon: masterMap[key] || 2
      };
    });

    return res.status(200).json({
      ok: true,
      total_tps: safeMaster.length,
      master_desa: safeMaster,
      data: enrichedData
    });
  } catch (err) {
    console.error('API GET-DATA ERROR:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
}
