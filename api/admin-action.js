const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body;

  if (body.action === 'login') {
    const { data } = await supabase
      .from('master_admin')
      .select('*')
      .eq('username', body.username)
      .eq('password', body.password)
      .limit(1);

    if (data && data.length > 0) {
      return res.status(200).json({ success: true, nama: data[0].nama_lengkap, role: data[0].role });
    }
    return res.status(200).json({ success: false, message: 'Username/Password Salah' });
  }

  if (body.action === 'updateStatus') {
    await supabase
      .from('hasil_suara')
      .update({ status_verifikasi: body.status })
      .eq('kecamatan', body.kecamatan)
      .eq('desa', body.desa)
      .eq('tps', body.tps);

    return res.status(200).json({ success: true });
  }
};