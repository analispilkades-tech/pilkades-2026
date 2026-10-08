import crypto from 'crypto';
import { supabase } from './supabase.js';

const SESSION_SECRET = process.env.SESSION_SECRET;
const COOKIE_NAME = 'admin_session';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function readCookie(req, name = COOKIE_NAME) {
  const cookie = req.headers.cookie || '';
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    const value = part.slice(index + 1).trim();
    try { return decodeURIComponent(value); } catch { return value; }
  }
  return null;
}

export function sessionTokenHash(token) {
  if (!SESSION_SECRET) throw new Error('SESSION_SECRET belum dikonfigurasi.');
  return sha256(`${token}${SESSION_SECRET}`);
}

export async function requireAdmin(req) {
  if (!SESSION_SECRET) {
    return { ok: false, status: 500, error: 'Konfigurasi session server belum tersedia.' };
  }

  const token = readCookie(req);
  if (!token) return { ok: false, status: 401, error: 'Belum login.' };

  const { data: session, error } = await supabase
    .from('admin_sessions')
    .select(`
      id,
      admin_id,
      expires_at,
      last_access,
      admin_users (
        id,
        nrp,
        nama,
        role,
        kecamatan,
        aktif
      )
    `)
    .eq('token_hash', sessionTokenHash(token))
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (error) {
    console.error('[ADMIN SESSION] QUERY ERROR:', error);
    return { ok: false, status: 500, error: 'Gagal memeriksa session admin.' };
  }

  if (!session?.admin_users) {
    return { ok: false, status: 401, error: 'Session admin tidak valid atau sudah berakhir.' };
  }

  const admin = session.admin_users;
  if (!admin.aktif) {
    return { ok: false, status: 403, error: 'Akun admin sudah tidak aktif.' };
  }

  let allowedKecamatan = null;
  const role = String(admin.role || '').trim().toUpperCase();

  if (role !== 'SUPERADMIN' && role !== 'SUPER_ADMIN') {
    const { data, error: accessError } = await supabase
      .from('admin_kecamatan')
      .select('kecamatan')
      .eq('admin_id', admin.id);

    if (accessError) {
      console.error('[ADMIN SESSION] ACCESS ERROR:', accessError);
      return { ok: false, status: 500, error: 'Gagal mengambil hak akses kecamatan.' };
    }

    allowedKecamatan = (data || [])
      .map(x => String(x.kecamatan || '').trim().toUpperCase())
      .filter(Boolean);

    if (!allowedKecamatan.length) {
      return { ok: false, status: 403, error: 'Admin belum memiliki wilayah akses.' };
    }
  }

  // A failed heartbeat must not log a user out; session validity is already established above.
  await supabase
    .from('admin_sessions')
    .update({ last_access: new Date().toISOString() })
    .eq('id', session.id);

  return { ok: true, session, admin, allowedKecamatan };
}

export function adminCanAccessKecamatan(admin, kecamatan, allowedKecamatan = undefined) {
  const role = String(admin?.role || '').trim().toUpperCase();
  if (role === 'SUPERADMIN' || role === 'SUPER_ADMIN') return true;

  const target = String(kecamatan || '').trim().toUpperCase();
  if (!target) return false;

  const allowed = allowedKecamatan ?? admin?.kecamatan;
  if (Array.isArray(allowed)) {
    return allowed.map(x => String(x).trim().toUpperCase()).includes(target);
  }
  if (typeof allowed === 'string') {
    try {
      const parsed = JSON.parse(allowed);
      if (Array.isArray(parsed)) {
        return parsed.map(x => String(x).trim().toUpperCase()).includes(target);
      }
    } catch {}
    return allowed.split(',').map(x => x.trim().toUpperCase()).filter(Boolean).includes(target);
  }
  return false;
}
