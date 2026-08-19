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
    // 1. Ambil data hasil_suara
    const { data: hasilData, error: hasilErr } = await supabase
      .from('hasil_suara')
      .select('*')
      .order('id', { ascending: false });

    if (hasilErr) console.error('Error fetch hasil_suara:', hasilErr);

    // 2. Ambil master_desa lengkap
    const { data: masterData, error: masterErr } = await supabase
      .from('master_desa')
      .select('*');

    if (masterErr) console.error('Error fetch master_desa:', masterErr);

    const safeHasil = Array.isArray(hasilData) ? hasilData : [];
    const safeMaster = Array.isArray(masterData) ? masterData : [];

    // Map info DPT dan Jumlah Calon per TPS
    const masterMap = {};
    safeMaster.forEach(m => {
      const kKec = String(m.kecamatan || '').toUpperCase().trim();
      const kDesa = String(m.desa || '').toUpperCase().trim();
      const kTps = String(m.tps || '').toUpperCase().trim();
      const key = `${kKec}_${kDesa}_${kTps}`;
      
      masterMap[key] = {
        jumlah_calon: Number(m.jumlah_calon || 2),
        dpt: Number(m.dpt || m.jumlah_dpt || m.dpt_total || 0)
      };
    });

    // Enrich data hasil_suara dengan DPT dan Jumlah Calon dari master
    const enrichedData = safeHasil.map(item => {
      const kKec = String(item.kecamatan || '').toUpperCase().trim();
      const kDesa = String(item.desa || '').toUpperCase().trim();
      const kTps = String(item.tps || '').toUpperCase().trim();
      const key = `${kKec}_${kDesa}_${kTps}`;
      const info = masterMap[key] || { jumlah_calon: 2, dpt: 0 };

      return {
        ...item,
        jumlah_calon: info.jumlah_calon,
        dpt: Number(item.dpt || info.dpt || 0)
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
