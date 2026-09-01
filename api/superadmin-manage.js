import { supabase } from '../lib/supabase.js';
import { requireAdmin } from '../lib/admin-session.js';

const ACTIONS = new Set([
  'LIST_ADMINS',
  'LIST_KECAMATAN',
  'CREATE_ADMIN',
  'UPDATE_ADMIN',
  'SET_ADMIN_STATUS'
]);

const ROLES = new Set(['ADMIN', 'SUPERADMIN', 'SUPER_ADMIN']);

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    const requestHost = req.headers['x-forwarded-host'] || req.headers.host || '';
    return originHost === requestHost;
  } catch {
    return false;
  }
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return {};
}

function securityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function rpcError(error) {
  const message = String(error?.message || 'Operasi superadmin gagal.');
  const match = message.match(/^([A-Z0-9_]+):\s*(.*)$/);
  return match
    ? { code: match[1], error: match[2] || match[1] }
    : { code: error?.code || 'SUPERADMIN_OPERATION_FAILED', error: message };
}

function isSuperAdmin(admin) {
  const role = String(admin?.role || '').trim().toUpperCase();
  return role === 'SUPERADMIN' || role === 'SUPER_ADMIN';
}

export default async function handler(req, res) {
  securityHeaders(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  if (req.method === 'POST' && !sameOrigin(req)) {
    return res.status(403).json({ ok: false, code: 'CSRF_ORIGIN_DENIED', error: 'Origin request tidak diizinkan.' });
  }

  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

    if (!isSuperAdmin(auth.admin)) {
      return res.status(403).json({ ok: false, code: 'SUPERADMIN_REQUIRED', error: 'Fitur ini hanya dapat digunakan oleh SUPERADMIN.' });
    }

    const body = req.method === 'POST' ? parseBody(req) : {};
    const action = String(body.action || (req.query?.action || 'LIST_ADMINS')).trim().toUpperCase();

    if (!ACTIONS.has(action)) {
      return res.status(400).json({ ok: false, code: 'INVALID_ACTION', error: `Aksi tidak valid. Tersedia: ${[...ACTIONS].join(', ')}` });
    }

    const { data: result, error } = await supabase.rpc('superadmin_manage_admin', {
      p_actor_admin_id: String(auth.admin.id),
      p_action: action,
      p_admin_id: body.admin_id == null ? null : String(body.admin_id),
      p_nrp: body.nrp == null ? null : String(body.nrp),
      p_nama: body.nama == null ? null : String(body.nama),
      p_role: body.role == null ? null : String(body.role),
      p_pin: body.pin == null ? null : String(body.pin),
      p_aktif: body.aktif == null ? null : Boolean(body.aktif),
      p_kecamatan: Array.isArray(body.kecamatan) ? body.kecamatan : null
    });

    if (error) {
      console.error('[SUPERADMIN MANAGE] RPC ERROR:', error);
      const mapped = rpcError(error);
      const status = [
        'ADMIN_NOT_ACTIVE',
        'SUPERADMIN_REQUIRED',
        'TARGET_NOT_FOUND',
        'DUPLICATE_NRP',
        'INVALID_ROLE',
        'INVALID_ADMIN_ID',
        'REGION_REQUIRED',
        'REGION_NOT_FOUND',
        'CANNOT_DEACTIVATE_SELF'
      ].includes(mapped.code) ? 400 : 500;
      return res.status(status).json({ ok: false, code: mapped.code, error: mapped.error });
    }

    return res.status(200).json({
      ok: true,
      action,
      roles: [...ROLES],
      data: result?.data ?? result ?? null
    });
  } catch (err) {
    console.error('[SUPERADMIN MANAGE] FATAL ERROR:', err);
    return res.status(500).json({ ok: false, code: 'SERVER_ERROR', error: 'Server error.' });
  }
}
