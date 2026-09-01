import { supabase } from '../lib/supabase.js';
import { requireAdmin } from '../lib/admin-session.js';

const PAGE_SIZE = 1000;
const PLANO_BATCH_SIZE = 500;

function securityHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
}

function chunk(values, size) {
  const result = [];
  for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size));
  return result;
}

export default async function handler(req, res) {
  securityHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

    const { admin, allowedKecamatan } = auth;
    const allRegions = allowedKecamatan === null;

    let hasilQuery = supabase
      .from('hasil_suara')
      .select('*')
      .order('id', { ascending: false });
    if (!allRegions) hasilQuery = hasilQuery.in('kecamatan', allowedKecamatan);

    const { data: hasilData, error: hasilErr } = await hasilQuery;
    if (hasilErr) {
      console.error('[GET-DATA] HASIL SUARA ERROR:', hasilErr);
      return res.status(500).json({ ok: false, error: 'Gagal mengambil data hasil suara.' });
    }

    let masterQuery = supabase.from('master_desa').select('*');
    if (!allRegions) masterQuery = masterQuery.in('kecamatan', allowedKecamatan);
    const { data: masterData, error: masterErr } = await masterQuery;
    if (masterErr) {
      console.error('[GET-DATA] MASTER DESA ERROR:', masterErr);
      return res.status(500).json({ ok: false, error: 'Gagal mengambil master desa.' });
    }

    const safeHasil = Array.isArray(hasilData) ? hasilData : [];
    const safeMaster = Array.isArray(masterData) ? masterData : [];

    // Never download the entire plano history for every admin refresh.
    // The SQL view returns only the newest completed OCR per hasil_suara row.
    const ids = safeHasil.map(x => Number(x.id)).filter(Number.isSafeInteger);
    const planoRows = [];
    for (const batch of chunk(ids, PLANO_BATCH_SIZE)) {
      if (!batch.length) continue;
      const { data, error } = await supabase
        .from('latest_plano_uploads')
        .select(`
          id,
          hasil_suara_id,
          google_drive_url,
          ocr_status,
          ocr_engine,
          ocr_text,
          ocr_calon_01,
          ocr_calon_02,
          ocr_calon_03,
          ocr_calon_04,
          ocr_calon_05,
          ocr_tidak_sah,
          ocr_total_suara,
          ocr_confidence,
          ocr_started_at,
          ocr_processed_at,
          ocr_error,
          created_at
        `)
        .in('hasil_suara_id', batch);
      if (error) {
        console.error('[GET-DATA] PLANO ERROR:', error);
        return res.status(500).json({ ok: false, error: 'Gagal mengambil data plano.' });
      }
      planoRows.push(...(data || []));
    }

    const masterMap = Object.create(null);
    for (const m of safeMaster) {
      const key = `${String(m.kecamatan || '').trim().toUpperCase()}_${String(m.desa || '').trim().toUpperCase()}_${String(m.tps || '').trim().toUpperCase()}`;
      masterMap[key] = {
        jumlah_calon: Number(m.jumlah_calon || 2),
        total_dpt: Number(m.total_dpt ?? m.dpt ?? 0)
      };
    }

    const planoMap = Object.create(null);
    for (const p of planoRows) planoMap[String(p.hasil_suara_id)] = p;

    const enrichedData = safeHasil.map(item => {
      const kKec = String(item.kecamatan || '').trim().toUpperCase();
      const kDesa = String(item.desa || '').trim().toUpperCase();
      const kTps = String(item.tps || '').trim().toUpperCase();
      const info = masterMap[`${kKec}_${kDesa}_${kTps}`] || { jumlah_calon: 2, total_dpt: 0 };
      const plano = planoMap[String(item.id)] || null;

      return {
        ...item,
        jumlah_calon: info.jumlah_calon,
        total_dpt: Number(item.total_dpt ?? info.total_dpt ?? 0),
        plano_upload_id: plano?.id ?? null,
        google_drive_url: plano?.google_drive_url ?? item.google_drive_url ?? null,
        ocr_status: plano?.ocr_status ?? null,
        ocr_engine: plano?.ocr_engine ?? null,
        ocr_calon_01: plano?.ocr_calon_01 ?? null,
        ocr_calon_02: plano?.ocr_calon_02 ?? null,
        ocr_calon_03: plano?.ocr_calon_03 ?? null,
        ocr_calon_04: plano?.ocr_calon_04 ?? null,
        ocr_calon_05: plano?.ocr_calon_05 ?? null,
        ocr_tidak_sah: plano?.ocr_tidak_sah ?? null,
        ocr_total_suara: plano?.ocr_total_suara ?? null,
        ocr_confidence: plano?.ocr_confidence ?? null,
        ocr_processed_at: plano?.ocr_processed_at ?? null,
        ocr_error: plano?.ocr_error ?? null
      };
    });

    return res.status(200).json({
      ok: true,
      admin: {
        id: admin.id,
        nrp: admin.nrp,
        nama: admin.nama,
        role: admin.role,
        kecamatan: allRegions ? 'ALL' : allowedKecamatan
      },
      total_tps: safeMaster.length,
      master_desa: safeMaster,
      data: enrichedData
    });
  } catch (err) {
    console.error('[GET-DATA] FATAL ERROR:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
}
