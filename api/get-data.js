import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    // Ambil seluruh data hasil suara untuk livecount
    const { data, error } = await supabase
      .from('hasil_suara')
      .select('*')
      .order('tps', { ascending: true });

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.status(200).json({ ok: true, data: data || [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
