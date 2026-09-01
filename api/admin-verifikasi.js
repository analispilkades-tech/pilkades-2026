import { supabase } from '../lib/supabase.js';
import { requireAdmin } from '../lib/admin-session.js';

const ACTIONS = [
  'SAHKAN_MANUAL',
  'SAHKAN_PLANO',
  'UBAH_DATA',
  'ROLLBACK_VERIFIKASI'
];

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    const requestHost =
      req.headers['x-forwarded-host'] ||
      req.headers.host || '';
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

function rpcError(error) {
  const message = String(error?.message || 'Aksi admin gagal diproses.');
  const match = message.match(/^([A-Z0-9_]+):\s*(.*)$/);
  return match
    ? { code: match[1], error: match[2] || match[1] }
    : { code: error?.code || 'ADMIN_ACTION_FAILED', error: message };
}

function securityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

export default async function handler(req, res) {
  securityHeaders(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  if (!sameOrigin(req)) {
    return res.status(403).json({ ok: false, code: 'CSRF_ORIGIN_DENIED', error: 'Origin request tidak diizinkan.' });
  }

  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) {
      return res.status(auth.status || 401).json({ ok: false, error: auth.error });
    }

    const body = parseBody(req);
    const id = Number(body.id);
    const action = String(body.action || '').trim().toUpperCase();
    const data = body.data;
    const rollbackReason = body.rollback_reason;

    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, code: 'INVALID_ID', error: 'ID hasil_suara tidak valid.' });
    }

    if (!ACTIONS.includes(action)) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_ACTION',
        error: `Aksi admin tidak valid. Aksi tersedia: ${ACTIONS.join(', ')}`
      });
    }

    if (action === 'UBAH_DATA' && (!data || typeof data !== 'object' || Array.isArray(data))) {
      return res.status(400).json({ ok: false, code: 'INVALID_DATA', error: 'Data perubahan wajib dikirim.' });
    }

    if (action === 'ROLLBACK_VERIFIKASI') {
      const reason = String(rollbackReason || '').trim();
      if (!reason) return res.status(400).json({ ok: false, code: 'ROLLBACK_REASON_REQUIRED', error: 'Alasan rollback wajib diisi.' });
      if (reason.length < 5) return res.status(400).json({ ok: false, code: 'ROLLBACK_REASON_TOO_SHORT', error: 'Alasan rollback minimal 5 karakter.' });
      if (reason.length > 1000) return res.status(400).json({ ok: false, code: 'ROLLBACK_REASON_TOO_LONG', error: 'Alasan rollback maksimal 1000 karakter.' });
    }

    const { data: result, error } = await supabase.rpc('admin_apply_verification_action', {
      p_admin_id: auth.admin.id,
      p_hasil_id: id,
      p_action: action,
      p_data: data ?? null,
      p_rollback_reason: rollbackReason ?? null,
      p_min_ocr_confidence: 40
    });

    if (error) {
      console.error('[ADMIN VERIFIKASI] RPC ERROR:', error);
      const mapped = rpcError(error);
      const status = [
        'DATA_NOT_FOUND',
        'DATA_ALREADY_VERIFIED',
        'DATA_ALREADY_CHANGED',
        'DATA_NOT_VERIFIED',
        'ROLLBACK_FAILED',
        'KECAMATAN_ACCESS_DENIED'
      ].includes(mapped.code) ? 409 :
        mapped.code === 'OCR_CONFIDENCE_TOO_LOW' ? 400 :
        mapped.code === 'ADMIN_NOT_ACTIVE' ? 403 : 500;

      return res.status(status).json({ ok: false, code: mapped.code, error: mapped.error });
    }

    return res.status(200).json({
      ok: true,
      action,
      message: result?.message || 'Aksi admin berhasil diproses.',
      status_verifikasi: result?.status_verifikasi || null,
      confidence: result?.confidence ?? null,
      total: result?.total ?? null,
      applied: result?.applied ?? null,
      rollback_reason: result?.rollback_reason ?? null,
      data: result?.data || null
    });
  } catch (err) {
    console.error('[ADMIN VERIFIKASI] FATAL ERROR:', err);
    return res.status(500).json({ ok: false, code: 'SERVER_ERROR', error: 'Server error.' });
  }
}
