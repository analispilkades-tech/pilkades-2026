import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const SESSION_SECRET = process.env.SESSION_SECRET;

function sha256(text) {
  return crypto
    .createHash('sha256')
    .update(text)
    .digest('hex');
}

function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS')
    return res.status(200).end();

  if (req.method !== 'POST')
    return res.status(405).json({
      ok:false,
      error:'Method not allowed'
    });

  try {

    const {
      nrp,
      pin
    } = req.body || {};

    if (!nrp || !pin) {
      return res.status(400).json({
        ok:false,
        error:'NRP dan PIN wajib diisi.'
      });
    }

    const {
      data: admin,
      error
    } = await supabase
      .from('admin_users')
      .select('*')
      .eq('nrp', nrp)
      .eq('aktif', true)
      .maybeSingle();

    if (error) throw error;

    if (!admin || admin.pin !== pin) {
      return res.status(401).json({
        ok:false,
        error:'NRP atau PIN salah.'
      });
    }

    const rawToken = createToken();

    const tokenHash = sha256(
      rawToken + SESSION_SECRET
    );

    const expires = new Date(
      Date.now() + 24 * 60 * 60 * 1000
    );

    const ip =
      req.headers['x-forwarded-for'] ||
      req.socket?.remoteAddress ||
      null;

    const ua =
      req.headers['user-agent'] ||
      null;

    const { error: sessionError } =
      await supabase
        .from('admin_sessions')
        .insert({
          admin_id: admin.id,
          token_hash: tokenHash,
          ip_address: ip,
          user_agent: ua,
          expires_at: expires.toISOString()
        });

    if (sessionError)
      throw sessionError;

    const secure =
      process.env.VERCEL
        ? '; Secure'
        : '';

    res.setHeader(
      'Set-Cookie',
      `admin_session=${rawToken}; HttpOnly; Path=/; SameSite=Lax${secure}; Max-Age=86400`
    );

    return res.status(200).json({
      ok:true,
      nama: admin.nama,
      role: admin.role,
      kecamatan: admin.kecamatan
    });

  } catch(err) {

    console.error(
      '[ADMIN LOGIN]',
      err
    );

    return res.status(500).json({
      ok:false,
      error:'Server error'
    });

  }

}
