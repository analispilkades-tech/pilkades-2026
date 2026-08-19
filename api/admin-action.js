import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method Not Allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { action, username, password } = body;

    if (action === 'login' || !action) {
      // Cek kredensial ke tabel master_admin di Supabase
      const { data: adminData, error } = await supabase
        .from('master_admin')
        .select('*')
        .eq('username', username)
        .eq('password', password)
        .maybeSingle();

      if (error) {
        console.error('SUPABASE DB ERROR:', error);
        return res.status(500).json({ success: false, message: 'Kesalahan saat mengakses database' });
      }

      if (adminData) {
        return res.status(200).json({
          success: true,
          ok: true,
          role: adminData.role || 'SUPER_ADMIN',
          nama: adminData.nama_lengkap || 'Panitia Utama',
          message: 'Login Berhasil'
        });
      } else {
        return res.status(401).json({
          success: false,
          ok: false,
          message: 'Username atau Password salah!'
        });
      }
    }

    return res.status(400).json({ success: false, message: 'Aksi tidak valid' });

  } catch (err) {
    console.error('SERVER ERROR:', err);
    return res.status(500).json({ success: false, message: err.message || 'Terjadi kesalahan pada server' });
  }
}
