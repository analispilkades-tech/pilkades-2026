import { requireAdmin } from '../lib/admin-session.js';

function securityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
}

export default async function handler(req, res) {
  securityHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

    return res.status(200).json({
      ok: true,
      admin: {
        id: auth.admin.id,
        nrp: auth.admin.nrp,
        nama: auth.admin.nama,
        role: auth.admin.role,
        aktif: auth.admin.aktif,
        kecamatan: auth.allowedKecamatan === null ? [] : auth.allowedKecamatan
      }
    });
  } catch (err) {
    console.error('[ADMIN AUTH] FATAL ERROR:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
}
