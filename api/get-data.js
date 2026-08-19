import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    // 1. Ambil data hasil suara
    const { data: hasilData, error: hasilErr } = await supabase
      .from('hasil_suara')
      .select('*')
      .order('tps', { ascending: true });

    if (hasilErr) throw hasilErr;

    // 2. Ambil master_desa untuk total TPS & jumlah calon per TPS
    const { data: masterData, error: masterErr } = await supabase
      .from('master_desa')
      .select('kecamatan, desa, tps, jumlah_calon');

    if (masterErr) throw masterErr;

    const totalTpsMaster = masterData ? masterData.length : 0;

    // Buat pemetaan jumlah calon per TPS
    const masterMap = {};
    masterData?.forEach(m => {
      const key = `${m.kecamatan}_${m.desa}_${m.tps}`.toUpperCase();
      masterMap[key] = Number(m.jumlah_calon || 2);
    });

    // Sisipkan atribut jumlah_calon ke setiap baris hasil suara
    const enrichedData = (hasilData || []).map(item => {
      const key = `${item.kecamatan}_${item.desa}_${item.tps}`.toUpperCase();
      return {
        ...item,
        jumlah_calon: masterMap[key] || 2
      };
    });

    return res.status(200).json({
      ok: true,
      total_tps: totalTpsMaster,
      data: enrichedData
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
