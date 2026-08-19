import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export default async function handler(req, res) {
  // Izinkan CORS agar frontend tidak terblokir peramban
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { action, username, password } = body;

    // Verifikasi Login Admin
    if (action === 'login' || !action) {
      const envUser = process.env.ADMIN_USERNAME || 'admin';
      const envPass = process.env.ADMIN_PASSWORD || 'admin123';

      if (username === envUser && password === envPass) {
        return res.status(200).json({
          ok: true,
          token: 'ADMIN_SESSION_TOKEN_2026',
          message: 'Login Berhasil'
        });
      } else {
        return res.status(401).json({
          ok: false,
          error: 'Username atau Password salah!'
        });
      }
    }

    return res.status(400).json({ ok: false, error: 'Aksi tidak valid' });

  } catch (error) {
    console.error('ADMIN AUTH ERROR:', error);
    return res.status(500).json({ ok: false, error: error.message || 'Terjadi kesalahan pada server' });
  }
}
