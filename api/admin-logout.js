import { supabase } from '../lib/supabase.js';
import { readCookie, sessionTokenHash } from '../lib/admin-session.js';

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host || ''); }
  catch { return false; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: 'Origin request tidak diizinkan.' });

  try {
    const token = readCookie(req);
    if (token) {
      await supabase.from('admin_sessions').delete().eq('token_hash', sessionTokenHash(token));
    }
    const secure = process.env.VERCEL ? '; Secure' : '';
    res.setHeader('Set-Cookie', `admin_session=; HttpOnly; Path=/; SameSite=Lax${secure}; Max-Age=0`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[ADMIN LOGOUT]', err);
    return res.status(500).json({ ok: false, error: 'Logout gagal.' });
  }
}
