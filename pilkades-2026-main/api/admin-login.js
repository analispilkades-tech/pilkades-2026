import crypto from 'crypto';
import { supabase } from '../lib/supabase.js';
import { sessionTokenHash } from '../lib/admin-session.js';

const SESSION_SECRET = process.env.SESSION_SECRET;

function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host || '');
  } catch {
    return false;
  }
}

function securityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
}

export default async function handler(req, res) {
  securityHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: 'Origin request tidak diizinkan.' });
  if (!SESSION_SECRET) return res.status(500).json({ ok: false, error: 'Konfigurasi session server belum tersedia.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const nrp = String(body.nrp || '').trim();
    const pin = String(body.pin || '');

    if (!nrp || !pin) return res.status(400).json({ ok: false, error: 'NRP dan PIN wajib diisi.' });
    if (nrp.length > 64 || pin.length > 128) return res.status(400).json({ ok: false, error: 'Format kredensial tidak valid.' });

    const { data: admins, error } = await supabase.rpc('admin_login_verify', {
      p_nrp: nrp,
      p_pin: pin
    });

    if (error) throw error;

    const admin = Array.isArray(admins) ? admins[0] : null;
    if (!admin) {
      return res.status(401).json({ ok: false, error: 'NRP atau PIN salah.' });
    }

    const rawToken = createToken();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 128) || null;
    const ua = String(req.headers['user-agent'] || '').slice(0, 512) || null;

    // Remove expired sessions for this admin to avoid unbounded session growth.
    await supabase.from('admin_sessions').delete().eq('admin_id', admin.id).lt('expires_at', new Date().toISOString());

    const { error: sessionError } = await supabase
      .from('admin_sessions')
      .insert({
        admin_id: admin.id,
        token_hash: sessionTokenHash(rawToken),
        ip_address: ip,
        user_agent: ua,
        expires_at: expires.toISOString()
      });

    if (sessionError) throw sessionError;

    const secure = process.env.VERCEL ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `admin_session=${encodeURIComponent(rawToken)}; HttpOnly; Path=/; SameSite=Lax${secure}; Max-Age=86400`
    );

    return res.status(200).json({ ok: true, nama: admin.nama, role: admin.role, kecamatan: admin.kecamatan });
  } catch (err) {
    console.error('[ADMIN LOGIN] FATAL ERROR:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
}
