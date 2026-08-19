import { createClient } from '@supabase/supabase-js';
import { createWorker } from 'tesseract.js';
import { waitUntil } from '@vercel/functions';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const BOT_TOKEN = process.env.BOT_TOKEN;
const GDRIVE_WEBHOOK_URL = process.env.GDRIVE_WEBHOOK_URL;
const MAX_CALON = 5;

/* =========================================================
   UTILITAS & TELEGRAM API
========================================================= */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function commandOf(text) {
  return String(text || '').trim().toLowerCase().split(/\s+/)[0];
}

async function telegramApi(method, payload = {}) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN belum diset.');
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    console.error(`Telegram API ERROR ${method}:`, JSON.stringify(result));
    throw new Error(result?.description || `Telegram API ${method} gagal.`);
  }
  return result;
}

async function sendMessage(chatId, text, replyMarkup = null) {
  const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  try {
    return await telegramApi('sendMessage', payload);
  } catch (error) {
    console.error('SEND MESSAGE ERROR:', error?.message || error);
    return null;
  }
}

async function answerCallbackQuery(callbackQueryId, text = '') {
  try {
    return await telegramApi('answerCallbackQuery', { callback_query_id: callbackQueryId, text, show_alert: false });
  } catch (error) {
    console.error('ANSWER CALLBACK ERROR:', error);
    return null;
  }
}

async function editMessage(chatId, messageId, text, replyMarkup = null) {
  const payload = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  try {
    return await telegramApi('editMessageText', payload);
  } catch (error) {
    console.error('EDIT MESSAGE ERROR:', error);
    return null;
  }
}

async function removeKeyboard(chatId, text) {
  return sendMessage(chatId, text, { remove_keyboard: true });
}

async function downloadTelegramFile(fileId) {
  const res = await telegramApi('getFile', { file_id: fileId });
  const filePath = res.result.file_path;
  const response = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/* =========================================================
   FUNGSI LOG AKTIVITAS (AUDIT LOG)
========================================================= */

async function logAktivitas({
  sumber_aksi = 'TELEGRAM_BOT',
  jenis_aksi,
  nrp_saksi = null,
  nama_saksi = null,
  kecamatan = null,
  desa = null,
  tps = null,
  data_sebelum = null,
  data_sesudah = null,
  keterangan = ''
}) {
  try {
    await supabase.from('log_aktivitas').insert({
      sumber_aksi,
      jenis_aksi,
      nrp_saksi,
      nama_saksi,
      kecamatan,
      desa,
      tps,
      data_sebelum,
      data_sesudah,
      keterangan
    });
  } catch (e) {
    console.error('LOG AKTIVITAS ERROR:', e);
  }
}

/* =========================================================
   OCR ENGINE - TESSERACT.JS
   OCR dijalankan sebagai proses background.
   Tidak boleh menghambat penyimpanan Live Count.
========================================================= */

async function runOCR(imageBuffer) {
  let worker = null;

  try {
    console.log('[OCR] Membuat worker Tesseract...');

    worker = await createWorker('eng', 1, {
      corePath:
        'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0',

      langPath:
        'https://tessdata.projectnaptha.com/4.0.0',

      cachePath: '/tmp',

      logger: (m) => {
        if (m?.status) {
          console.log(
            `[OCR] ${m.status} ${Math.round((m.progress || 0) * 100)}%`
          );
        }
      }
    });

    console.log('[OCR] Worker siap.');

    await worker.setParameters({
      tessedit_char_whitelist:
        '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz:-/#.',
      preserve_interword_spaces: '1'
    });

    console.log('[OCR] Memulai pembacaan gambar...');

    const result = await worker.recognize(imageBuffer);

    const text = result?.data?.text || '';
    const confidence = Number(
      result?.data?.confidence || 0
    );

    console.log('[OCR] Selesai.');
    console.log('[OCR] Confidence:', confidence);
    console.log('[OCR] Text:', text);

    return {
      text,
      confidence
    };

  } catch (error) {

    console.error(
      '[OCR] ERROR:',
      error?.stack ||
      error?.message ||
      error
    );

    throw error;

  } finally {

    if (worker) {
      try {
        await worker.terminate();
      } catch (terminateError) {
        console.error(
          '[OCR] Gagal terminate worker:',
          terminateError?.message ||
          terminateError
        );
      }
    }
  }
}

function parseOCRVotes(ocrText, jumlahCalon) {
  const normalized = String(ocrText || '')
    .toUpperCase()
    .replace(/\r/g, '\n');

  /*
   * PENTING:
   *
   * null = OCR TIDAK BERHASIL MEMBACA NILAI
   * 0    = OCR BENAR-BENAR MEMBACA ANGKA 0
   *
   * Jangan samakan kedua kondisi tersebut.
   */

  const result = {
    calon_01: null,
    calon_02: null,
    calon_03: null,
    calon_04: null,
    calon_05: null,
    tidak_sah: null
  };

  let ditemukan = 0;

  /*
   * ---------------------------------------------------------
   * BACA "CALON 01", "CALON 02", dst.
   * ---------------------------------------------------------
   */

  for (let i = 1; i <= jumlahCalon; i++) {

    const num = String(i).padStart(2, '0');

    const patterns = [
      new RegExp(
        `CALON\\s*${num}\\D{0,15}(\\d{1,4})`,
        'i'
      ),

      new RegExp(
        `CALON\\s*${i}\\D{0,15}(\\d{1,4})`,
        'i'
      )
    ];

    let match = null;

    for (const pattern of patterns) {
      match = normalized.match(pattern);
      if (match) break;
    }

    if (match) {

      const value = parseInt(match[1], 10);

      if (Number.isInteger(value)) {
        result[`calon_${num}`] = value;
        ditemukan++;
      }
    }
  }

  /*
   * ---------------------------------------------------------
   * BACA TIDAK SAH
   * ---------------------------------------------------------
   */

  const tsPatterns = [
    /(TIDAK\s*SAH)\D{0,15}(\d{1,4})/i,
    /\bTS\D{0,15}(\d{1,4})/i
  ];

  for (const pattern of tsPatterns) {

    const match = normalized.match(pattern);

    if (match) {

      const value =
        parseInt(
          match[match.length - 1],
          10
        );

      if (Number.isInteger(value)) {
        result.tidak_sah = value;
        ditemukan++;
        break;
      }
    }
  }

  /*
   * ---------------------------------------------------------
   * HASIL PARSING
   * ---------------------------------------------------------
   */

  result._ditemukan = ditemukan;

  result._lengkap =
    ditemukan >= jumlahCalon + 1;

  return result;
}

/* =========================================================
   FUNGSI BANTUAN DATA
========================================================= */

function parseVoteInput(text, jumlahCalon) {
  const parts = String(text).split('#').map(v => v.trim());
  if (parts.length !== jumlahCalon + 1) return { error: `Format butuh ${jumlahCalon + 1} angka.` };
  if (parts.some(v => v === '' || !/^\d+$/.test(v))) return { error: 'Semua nilai harus berupa angka positif.' };
  
  const values = parts.map(v => parseInt(v, 10));
  const result = { calon_01: 0, calon_02: 0, calon_03: 0, calon_04: 0, calon_05: 0, tidak_sah: values[values.length - 1] };
  for (let i = 0; i < jumlahCalon; i++) result[`calon_${String(i + 1).padStart(2, '0')}`] = values[i];
  result.total = values.reduce((a, b) => a + b, 0);
  return { error: null, result };
}

function buildSummaryText(tps, voteObj, jumlahCalon) {
  let text = `📍 TPS : ${escapeHtml(tps)}\n\n`;
  for (let i = 1; i <= jumlahCalon; i++) {
    const key = `calon_${String(i).padStart(2, '0')}`;
    text += `• Calon ${String(i).padStart(2, '0')}: ${voteObj[key]}\n`;
  }
  text += `• Tidak Sah: ${voteObj.tidak_sah}\n-------------------------\n• Total Suara Masuk: ${voteObj.total}`;
  return text;
}

/* =========================================================
   PROSES FOTO PLANO DI LATAR BELAKANG
========================================================= */

async function processPlanoPhotoInBackground(chatId, tpsTarget, fileId, petugas) {
  let planoUploadId = null;
  let hasilSuaraId = null;

  try {
    console.log(
      `[PLANO] Mulai proses TPS ${tpsTarget} - ${petugas.kecamatan}/${petugas.desa}`
    );

    /*
     * =========================================================
     * 1. CARI / BUAT HASIL SUARA
     *    Bagian ini hanya untuk menjaga Live Count.
     *    TIDAK BERGANTUNG PADA OCR.
     * =========================================================
     */

    const { data: dbHasilAwal, error: hasilError } = await supabase
      .from('hasil_suara')
      .select('*')
      .eq('kecamatan', petugas.kecamatan)
      .eq('desa', petugas.desa)
      .eq('tps', tpsTarget)
      .maybeSingle();

    if (hasilError) {
      throw new Error(
        `Gagal membaca hasil_suara: ${hasilError.message}`
      );
    }

    if (!dbHasilAwal) {
      const { data: hasilBaru, error: insertHasilError } = await supabase
        .from('hasil_suara')
        .insert({
          kecamatan: petugas.kecamatan,
          desa: petugas.desa,
          tps: tpsTarget,
          nrp_saksi: petugas.nrp,
          nama_saksi: petugas.nama_petugas,
          status_verifikasi: 'FOTO PLANO BELUM TERVERIFIKASI',
          telegram_photo_file_id: fileId
        })
        .select('id')
        .single();

      if (insertHasilError) {
        throw new Error(
          `Gagal membuat hasil_suara: ${insertHasilError.message}`
        );
      }

      hasilSuaraId = hasilBaru.id;

    } else {

      hasilSuaraId = dbHasilAwal.id;

      const { error: updateHasilError } = await supabase
        .from('hasil_suara')
        .update({
          status_verifikasi: 'FOTO PLANO BELUM TERVERIFIKASI',
          telegram_photo_file_id: fileId
        })
        .eq('id', dbHasilAwal.id);

      if (updateHasilError) {
        console.error(
          '[PLANO] Gagal update status hasil_suara:',
          updateHasilError.message
        );
      }
    }

    /*
     * =========================================================
     * 2. BUAT RECORD plano_uploads
     *
     *    INI WAJIB DILAKUKAN SEBELUM OCR.
     * =========================================================
     */

    const { data: planoUpload, error: planoInsertError } = await supabase
      .from('plano_uploads')
      .insert({
        hasil_suara_id: hasilSuaraId,
        kecamatan: petugas.kecamatan,
        desa: petugas.desa,
        tps: tpsTarget,
        nrp_saksi: petugas.nrp,
        nama_saksi: petugas.nama_petugas,
        chat_id_saksi: chatId,
        telegram_photo_file_id: fileId,
        ocr_status: 'PENDING',
        ocr_engine: 'Tesseract.js 5.0.5'
      })
      .select('id')
      .single();

    if (planoInsertError) {
      throw new Error(
        `Gagal insert plano_uploads: ${planoInsertError.message}`
      );
    }

    planoUploadId = planoUpload.id;

    console.log(
      `[PLANO] plano_uploads berhasil dibuat. ID=${planoUploadId}`
    );

    /*
     * =========================================================
     * 3. DOWNLOAD FOTO DARI TELEGRAM
     * =========================================================
     */

    const imageBuffer = await downloadTelegramFile(fileId);

    console.log(
      `[PLANO] Foto berhasil didownload. Size=${imageBuffer.length} bytes`
    );

    /*
     * =========================================================
     * 4. UPLOAD KE GOOGLE DRIVE
     * =========================================================
     */

    const cleanKec = String(
      petugas.kecamatan || 'kec'
    )
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_');

    const cleanDesa = String(
      petugas.desa || 'desa'
    )
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_');

    const cleanTps = String(
      tpsTarget || '1'
    )
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_');

    const customFileName =
      `${cleanKec}_${cleanDesa}_${cleanTps}.jpg`;

    let googleDriveUrl = null;

    if (GDRIVE_WEBHOOK_URL) {
      try {

        const driveRes = await fetch(GDRIVE_WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            base64Data: imageBuffer.toString('base64'),
            mimeType: 'image/jpeg',
            fileName: customFileName
          })
        });

        const driveJson = await driveRes.json();

        if (driveJson.success) {
          googleDriveUrl = driveJson.url;

          console.log(
            `[PLANO] Google Drive berhasil: ${googleDriveUrl}`
          );

          await supabase
            .from('plano_uploads')
            .update({
              google_drive_url: googleDriveUrl
            })
            .eq('id', planoUploadId);

          await supabase
            .from('hasil_suara')
            .update({
              google_drive_url: googleDriveUrl
            })
            .eq('id', hasilSuaraId);

        } else {
          console.error(
            '[PLANO] Google Drive gagal:',
            driveJson
          );
        }

      } catch (driveError) {

        console.error(
          '[PLANO] Gagal kirim ke Google Drive:',
          driveError?.message || driveError
        );
      }
    }

    /*
     * =========================================================
     * 5. MULAI OCR
     * =========================================================
     */

    await supabase
      .from('plano_uploads')
      .update({
        ocr_status: 'PROCESSING',
        ocr_started_at: new Date().toISOString()
      })
      .eq('id', planoUploadId);

    console.log(
      `[OCR] Mulai OCR untuk plano_uploads ID=${planoUploadId}`
    );

    let ocr;

    try {

      ocr = await runOCR(imageBuffer);

    } catch (ocrErr) {

      const errorMessage =
        ocrErr?.stack ||
        ocrErr?.message ||
        String(ocrErr);

      console.error(
        `[OCR] Gagal untuk plano_uploads ID=${planoUploadId}:`,
        errorMessage
      );

      await supabase
        .from('plano_uploads')
        .update({
          ocr_status: 'FAILED',
          ocr_engine: 'Tesseract.js 5.0.5',
          ocr_error: errorMessage,
          ocr_processed_at: new Date().toISOString()
        })
        .eq('id', planoUploadId);

      /*
       * SANGAT PENTING:
       * OCR gagal TIDAK boleh mengubah Live Count.
       */

      return;
    }

    const ocrText = ocr?.text || '';
    const confidence = Number(ocr?.confidence || 0);

    console.log(
      `[OCR] Berhasil. Confidence=${confidence}`
    );

    console.log(
      '=== HASIL MENTAH OCR TESSERACT ==='
    );

    console.log(ocrText);

    /*
 * =========================================================
 * VALIDASI CONFIDENCE OCR
 *
 * OCR dengan confidence terlalu rendah tidak boleh
 * digunakan untuk membandingkan Live Count.
 *
 * Live Count TIDAK diubah.
 * =========================================================
 */

const OCR_MIN_CONFIDENCE = 40;

if (confidence < OCR_MIN_CONFIDENCE) {

  console.warn(
    `[OCR] Confidence terlalu rendah: ${confidence}. ` +
    `Minimum=${OCR_MIN_CONFIDENCE}`
  );

  await supabase
    .from('plano_uploads')
    .update({
      ocr_status: 'LOW_CONFIDENCE',
      ocr_engine: 'Tesseract.js 5.0.5',
      ocr_text: ocrText,
      ocr_confidence: confidence,
      ocr_processed_at: new Date().toISOString(),
      ocr_error:
        `Confidence OCR terlalu rendah (${confidence}). ` +
        `Minimum yang diperlukan: ${OCR_MIN_CONFIDENCE}.`
    })
    .eq('id', planoUploadId);

  await logAktivitas({
    jenis_aksi: 'OCR_LOW_CONFIDENCE',
    nrp_saksi: petugas.nrp,
    nama_saksi: petugas.nama_petugas,
    kecamatan: petugas.kecamatan,
    desa: petugas.desa,
    tps: tpsTarget,

    data_sesudah: {
      ocr_confidence: confidence,
      ocr_status: 'LOW_CONFIDENCE'
    },

    keterangan:
      `OCR Foto Plano TPS ${tpsTarget} memiliki ` +
      `confidence rendah (${confidence}). ` +
      `Tidak dilakukan verifikasi otomatis.`
  });

  await sendMessage(
    chatId,
    `⚠️ <b>PEMBACAAN FOTO PLANO BELUM CUKUP JELAS</b>\n\n` +
    `Foto plano berhasil diterima dan disimpan.\n\n` +
    `Namun sistem belum dapat membaca angka ` +
    `dengan tingkat keyakinan yang cukup untuk ` +
    `melakukan verifikasi otomatis.\n\n` +
    `📊 <b>HASIL LIVE COUNT TETAP TIDAK BERUBAH.</b>\n\n` +
    `Silakan periksa foto plano atau kirim ulang ` +
    `foto yang lebih jelas.`
  );

  return;
}
    
    /*
     * =========================================================
     * 6. JIKA OCR TIDAK MEMBACA APA-APA
     * =========================================================
     */

    if (!ocrText.trim()) {

      await supabase
        .from('plano_uploads')
        .update({
          ocr_status: 'NO_TEXT',
          ocr_engine: 'Tesseract.js 5.0.5',
          ocr_text: '',
          ocr_confidence: confidence,
          ocr_processed_at: new Date().toISOString()
        })
        .eq('id', planoUploadId);

      console.log(
        `[OCR] Tidak ada text terbaca. ID=${planoUploadId}`
      );

      return;
    }

    /*
     * =========================================================
     * 7. CARI JUMLAH CALON
     * =========================================================
     */

    const { data: mDesa } = await supabase
      .from('master_desa')
      .select('jumlah_calon')
      .eq('kecamatan', petugas.kecamatan)
      .eq('desa', petugas.desa)
      .eq('tps', tpsTarget)
      .maybeSingle();

    const jumlahCalon =
      mDesa?.jumlah_calon || 2;

    /*
     * =========================================================
     * 8. PARSE HASIL OCR
     * =========================================================
     */

const ocrRes =
  parseOCRVotes(
    ocrText,
    jumlahCalon
  );

/*
 * =========================================================
 * VALIDASI HASIL PARSING OCR
 *
 * Jangan menganggap nilai yang tidak terbaca sebagai 0.
 * =========================================================
 */

console.log(
  '[OCR] Hasil parsing:',
  JSON.stringify(ocrRes)
);

if (!ocrRes._lengkap) {

  console.warn(
    `[OCR] Data OCR tidak lengkap. ` +
    `Ditemukan ${ocrRes._ditemukan} ` +
    `dari ${jumlahCalon + 1} nilai.`
  );

  await supabase
    .from('plano_uploads')
    .update({
      ocr_status: 'LOW_CONFIDENCE',
      ocr_engine: 'Tesseract.js 5.0.5',
      ocr_text: ocrText,
      ocr_calon_01: ocrRes.calon_01,
      ocr_calon_02: ocrRes.calon_02,
      ocr_calon_03: ocrRes.calon_03,
      ocr_calon_04: ocrRes.calon_04,
      ocr_calon_05: ocrRes.calon_05,
      ocr_tidak_sah: ocrRes.tidak_sah,
      ocr_confidence: confidence,
      ocr_processed_at: new Date().toISOString(),
      ocr_error:
        `Hasil OCR tidak lengkap. ` +
        `Ditemukan ${ocrRes._ditemukan} ` +
        `dari ${jumlahCalon + 1} nilai.`
    })
    .eq('id', planoUploadId);

  await logAktivitas({
    jenis_aksi: 'OCR_HASIL_TIDAK_LENGKAP',
    nrp_saksi: petugas.nrp,
    nama_saksi: petugas.nama_petugas,
    kecamatan: petugas.kecamatan,
    desa: petugas.desa,
    tps: tpsTarget,

    data_sesudah: {
      ocr: ocrRes,
      confidence
    },

    keterangan:
      `OCR Foto Plano TPS ${tpsTarget} tidak menghasilkan ` +
      `data lengkap. Tidak dilakukan verifikasi otomatis.`
  });

  await sendMessage(
    chatId,
    `⚠️ <b>HASIL OCR BELUM LENGKAP</b>\n\n` +
    `Foto plano berhasil diproses, tetapi sistem ` +
    `belum berhasil membaca seluruh angka suara.\n\n` +
    `📊 <b>HASIL LIVE COUNT TETAP TIDAK BERUBAH.</b>\n\n` +
    `Silakan periksa atau kirim ulang foto plano ` +
    `dengan posisi dan pencahayaan yang lebih jelas.`
  );

  return;
}

/*
 * =========================================================
 * HITUNG TOTAL OCR
 * =========================================================
 */

let ocrTotal = 0;

for (let i = 1; i <= jumlahCalon; i++) {

  const key =
    `calon_${String(i).padStart(2, '0')}`;

  ocrTotal += Number(
    ocrRes[key]
  );
}

ocrTotal += Number(
  ocrRes.tidak_sah
);

ocrRes.total = ocrTotal;
    /*
 * =========================================================
 * 9. SIMPAN HASIL OCR KE plano_uploads
 * =========================================================
 */

console.log(
  `[OCR] Menyimpan hasil OCR ke plano_uploads ID=${planoUploadId}...`
);

const { error: ocrUpdateError } = await supabase
  .from('plano_uploads')
  .update({
    ocr_status: 'COMPLETED',
    ocr_engine: 'Tesseract.js 5.0.5',
    ocr_text: ocrText,
    ocr_calon_01: ocrRes.calon_01,
    ocr_calon_02: ocrRes.calon_02,
    ocr_calon_03: ocrRes.calon_03,
    ocr_calon_04: ocrRes.calon_04,
    ocr_calon_05: ocrRes.calon_05,
    ocr_tidak_sah: ocrRes.tidak_sah,
    ocr_total_suara: ocrTotal,
    ocr_confidence: confidence,
    ocr_processed_at: new Date().toISOString(),
    ocr_error: null
  })
  .eq('id', planoUploadId);

if (ocrUpdateError) {

  console.error(
    `[OCR] GAGAL menyimpan hasil OCR ID=${planoUploadId}:`,
    ocrUpdateError.message
  );

} else {

  console.log(
    `[OCR] Hasil OCR berhasil disimpan ID=${planoUploadId}`
  );
}

    console.log(
  `[OCR] Melanjutkan proses verifikasi ID=${planoUploadId}`
);

    /*
     * =========================================================
     * 10. AMBIL HASIL MANUAL TERBARU
     * =========================================================
     */

    const { data: dbHasilTerbaru } = await supabase
      .from('hasil_suara')
      .select('*')
      .eq('id', hasilSuaraId)
      .maybeSingle();

    if (!dbHasilTerbaru) {

      console.error(
        `[OCR] hasil_suara ID=${hasilSuaraId} tidak ditemukan`
      );

      return;
    }

    /*
     * =========================================================
     * 11. JIKA BELUM ADA INPUT MANUAL
     *
     * OCR HANYA DISIMPAN SEBAGAI REFERENSI.
     * LIVE COUNT TIDAK DIUBAH.
     * =========================================================
     */

    const belumAdaInputManual =
      dbHasilTerbaru.suara_calon_01 === null ||
      dbHasilTerbaru.suara_calon_01 === undefined;

    if (belumAdaInputManual) {

      await logAktivitas({
        jenis_aksi: 'UPLOAD_PLANO',
        nrp_saksi: petugas.nrp,
        nama_saksi: petugas.nama_petugas,
        kecamatan: petugas.kecamatan,
        desa: petugas.desa,
        tps: tpsTarget,
        data_sesudah: ocrRes,
        keterangan:
          `Upload Foto Plano ${customFileName} - OCR tersimpan, belum ada input manual`
      });

      return;
    }

    /*
     * =========================================================
     * 12. BANDINGKAN OCR VS INPUT MANUAL
     * =========================================================
     */

    let isMatch = true;

    for (let i = 1; i <= jumlahCalon; i++) {

      const key =
        `calon_${String(i).padStart(2, '0')}`;

      if (
        Number(
          dbHasilTerbaru[`suara_${key}`] || 0
        ) !== Number(ocrRes[key] || 0)
      ) {
        isMatch = false;
      }
    }

    if (
      Number(dbHasilTerbaru.suara_tidak_sah || 0) !==
      Number(ocrRes.tidak_sah || 0)
    ) {
      isMatch = false;
    }

    /*
     * =========================================================
     * 13. AUTO VERIFIED
     * =========================================================
     */

    if (isMatch) {

      await supabase
        .from('hasil_suara')
        .update({
          status_verifikasi: 'AUTO VERIFIED'
        })
        .eq('id', hasilSuaraId);

      await logAktivitas({
        jenis_aksi: 'AUTO_VERIFIED',
        nrp_saksi: petugas.nrp,
        nama_saksi: petugas.nama_petugas,
        kecamatan: petugas.kecamatan,
        desa: petugas.desa,
        tps: tpsTarget,
        data_sesudah: {
          status_verifikasi: 'AUTO VERIFIED'
        },
        keterangan:
          `Foto Plano TPS ${tpsTarget} terverifikasi otomatis`
      });

      await sendMessage(
        chatId,
        `✅ <b>FOTO PLANO TPS ${escapeHtml(tpsTarget)} TERVERIFIKASI (AUTO VERIFIED)</b>`
      );

      return;
    }

    /*
     * =========================================================
     * 14. PLANO TIDAK SESUAI
     *
     * JANGAN mengubah angka Live Count.
     * Hanya ubah status verifikasi.
     * =========================================================
     */

    await supabase
      .from('hasil_suara')
      .update({
        status_verifikasi: 'PLANO TIDAK SESUAI'
      })
      .eq('id', hasilSuaraId);

    await logAktivitas({
      jenis_aksi: 'PLANO_TIDAK_SESUAI',
      nrp_saksi: petugas.nrp,
      nama_saksi: petugas.nama_petugas,
      kecamatan: petugas.kecamatan,
      desa: petugas.desa,
      tps: tpsTarget,
      data_sebelum: {
        suara_01: dbHasilTerbaru.suara_calon_01,
        suara_02: dbHasilTerbaru.suara_calon_02,
        suara_03: dbHasilTerbaru.suara_calon_03,
        suara_04: dbHasilTerbaru.suara_calon_04,
        suara_05: dbHasilTerbaru.suara_calon_05,
        ts: dbHasilTerbaru.suara_tidak_sah
      },
      data_sesudah: ocrRes,
      keterangan:
        `Ketidakcocokan antara Foto Plano dan Input Manual TPS ${tpsTarget}`
    });

    const manualVote = {
      calon_01: dbHasilTerbaru.suara_calon_01,
      calon_02: dbHasilTerbaru.suara_calon_02,
      calon_03: dbHasilTerbaru.suara_calon_03,
      calon_04: dbHasilTerbaru.suara_calon_04,
      calon_05: dbHasilTerbaru.suara_calon_05,
      tidak_sah: dbHasilTerbaru.suara_tidak_sah,
      total: dbHasilTerbaru.total_suara_masuk
    };

    const msg =
      `⚠️ <b>DITEMUKAN HASIL INPUT DAN PLANO TIDAK SESUAI</b>\n\n` +
      `📊 <b>HASIL SUARA DICATAT</b>\n` +
      `${buildSummaryText(tpsTarget, manualVote, jumlahCalon)}\n\n` +
      `📊 <b>PEMBACAAN PLANO</b>\n` +
      `${buildSummaryText(tpsTarget, ocrRes, jumlahCalon)}`;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: 'Pakai hasil input manual',
            callback_data:
              `USE_MANUAL_${hasilSuaraId}`
          }
        ],
        [
          {
            text: 'Pakai hasil pembacaan plano',
            callback_data:
              `USE_PLANO_${hasilSuaraId}`
          }
        ]
      ]
    };

    await sendMessage(
      chatId,
      msg,
      keyboard
    );

  } catch (err) {

    console.error(
      '[PLANO] ERROR BACKGROUND:',
      err?.stack || err?.message || err
    );

    /*
     * Jika record plano_uploads sudah berhasil dibuat,
     * tandai sebagai FAILED.
     */

    if (planoUploadId) {

      try {

        await supabase
          .from('plano_uploads')
          .update({
            ocr_status: 'FAILED',
            ocr_error:
              err?.stack ||
              err?.message ||
              String(err),
            ocr_processed_at:
              new Date().toISOString()
          })
          .eq('id', planoUploadId);

      } catch (dbError) {

        console.error(
          '[PLANO] Gagal menyimpan error OCR:',
          dbError?.message || dbError
        );
      }
    }
  }
}

/* =========================================================
   MAIN WEBHOOK HANDLER
========================================================= */

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  try {
    const update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!update) return res.status(200).json({ ok: true });

    if (update.callback_query) {
      await handleCallback(update.callback_query);
      return res.status(200).json({ ok: true });
    }

    const message = update.message;
    if (!message) return res.status(200).json({ ok: true });

    const chatId = String(message.chat?.id || '');
    const text = message.text ? String(message.text).trim() : '';
    const command = commandOf(text);

    if (command === '/start' || command.startsWith('/start@')) {
      const { data: petugas } = await supabase.from('master_petugas').select('*').eq('chat_id_telegram', chatId).maybeSingle();
      if (petugas) {
        const msg = `👤 <b>ANDA SUDAH TERDAFTAR</b>\n\n` +
          `Nama : <b>${escapeHtml(petugas.nama_petugas)}</b>\n` +
          `NRP : <code>${escapeHtml(petugas.nrp)}</code>\n` +
          `Kecamatan : <b>${escapeHtml(petugas.kecamatan)}</b>\n` +
          `Desa : <b>${escapeHtml(petugas.desa)}</b>\n` +
          `TPS Aktif : <b>${escapeHtml(petugas.tps_aktif || '-')}</b>\n\n` +
          `Status : ✅ <b>TERDAFTAR</b>`;
        await sendMessage(chatId, msg);
      } else {
        const msg = `🇮🇩 <b>SELAMAT DATANG</b>\n\nBot Penghitungan Cepat Pilkades\nKabupaten Wonosobo Tahun 2026\n\n` +
          `Untuk melakukan registrasi petugas, ketik:\n\n<code>/reg NRP</code>\n\nContoh:\n<code>/reg 12345678</code>`;
        await sendMessage(chatId, msg);
      }
      return res.status(200).json({ ok: true });
    }

    if (command === '/help' || command.startsWith('/help@')) {
      const msg = `📋 <b>DAFTAR PERINTAH BOT</b>\n\n` +
        `<code>/start</code> - Menu utama & status\n` +
        `<code>/reg NRP</code> - Pendaftaran petugas\n` +
        `<code>/kirimhasil</code> - Kirim hasil penghitungan suara\n` +
        `<code>/edithasil</code> - Edit hasil suara yang sudah masuk\n` +
        `<code>/lihathasil</code> - Lihat rekapitulasi hasil suara desa\n` +
        `<code>/kirimplano</code> - Upload foto C1 Plano\n` +
        `<code>/status</code> - Cek rincian status TPS\n` +
        `<code>/batal</code> - Batal proses\n` +
        `<code>/help</code> - Bantuan`;
      await sendMessage(chatId, msg);
      return res.status(200).json({ ok: true });
    }

    if (command === '/batal' || command.startsWith('/batal@')) {
      await supabase.from('master_petugas').update({ chat_id_telegram: null }).eq('chat_id_telegram', `WAIT_${chatId}`);
      const { data: petugas } = await supabase.from('master_petugas').select('*').eq('chat_id_telegram', chatId).maybeSingle();
      if (petugas) {
        await supabase.from('master_petugas').update({ mode_input: null, tps_aktif: null }).eq('nrp', petugas.nrp);
        await logAktivitas({
          jenis_aksi: 'BATAL_PROSES',
          nrp_saksi: petugas.nrp,
          nama_saksi: petugas.nama_petugas,
          kecamatan: petugas.kecamatan,
          desa: petugas.desa,
          tps: petugas.tps_aktif,
          keterangan: `Petugas membatalkan alur perintah`
        });
      }
      await removeKeyboard(chatId, `✅ Proses dibatalkan.\nKetik /start untuk kembali.`);
      return res.status(200).json({ ok: true });
    }

    const { data: waitUser } = await supabase.from('master_petugas').select('*').eq('chat_id_telegram', `WAIT_${chatId}`).maybeSingle();
    if (waitUser) {
      if (!text.startsWith('/')) {
        if (text === String(waitUser.pin ?? '').trim()) {
          const { error: updateErr } = await supabase
            .from('master_petugas')
            .update({ chat_id_telegram: chatId })
            .eq('nrp', waitUser.nrp);

          if (updateErr) {
            console.error('GAGAL UPDATE CHAT ID:', updateErr);
            await sendMessage(chatId, `❌ Terjadi kesalahan sistem saat menyimpan verifikasi.`);
            return res.status(200).json({ ok: true });
          }

          await logAktivitas({
            jenis_aksi: 'REGISTRASI_SUKSES',
            nrp_saksi: waitUser.nrp,
            nama_saksi: waitUser.nama_petugas,
            kecamatan: waitUser.kecamatan,
            desa: waitUser.desa,
            keterangan: `Registrasi akun Telegram petugas ${waitUser.nama_petugas} (${waitUser.nrp}) berhasil`
          });

          const msg = `🎉 <b>REGISTRASI BERHASIL</b>\n\nSelamat datang,\n<b>${escapeHtml(waitUser.nama_petugas)}</b>\n\n` +
            `📍 Kecamatan : <b>${escapeHtml(waitUser.kecamatan)}</b>\n🏘 Desa : <b>${escapeHtml(waitUser.desa)}</b>\n\n` +
            `Untuk melaporkan hasil penghitungan suara:\n/kirimhasil`;
          await removeKeyboard(chatId, msg);
        } else {
          await logAktivitas({
            jenis_aksi: 'REGISTRASI_PIN_SALAH',
            nrp_saksi: waitUser.nrp,
            nama_saksi: waitUser.nama_petugas,
            kecamatan: waitUser.kecamatan,
            desa: waitUser.desa,
            keterangan: `PIN salah dimasukkan oleh NRP ${waitUser.nrp}`
          });

          await sendMessage(chatId, `❌ <b>PIN SALAH, SILAHKAN INPUT KEMBALI ATAU HUBUNGI ADMIN</b>\n\nuntuk membatalkan proses ketik /batal`);
        }
        return res.status(200).json({ ok: true });
      }
    }

    const { data: petugas } = await supabase.from('master_petugas').select('*').eq('chat_id_telegram', chatId).maybeSingle();

    if (command === '/reg' || command.startsWith('/reg@')) {
      if (petugas) {
        await sendMessage(chatId, `👤 <b>ANDA SUDAH TERDAFTAR</b>\n\nNama : ${escapeHtml(petugas.nama_petugas)}\nNRP : ${escapeHtml(petugas.nrp)}`);
        return res.status(200).json({ ok: true });
      }

      const parts = text.split(/\s+/);
      const nrpInput = parts[1] ? parts[1].trim() : '';

      if (!nrpInput) {
        await sendMessage(chatId, `⚠️ <b>FORMAT SALAH</b>\nContoh: <code>/reg 12345678</code>`);
        return res.status(200).json({ ok: true });
      }

      const { data: masterP } = await supabase.from('master_petugas').select('*').eq('nrp', nrpInput).maybeSingle();
      if (!masterP) {
        await logAktivitas({
          jenis_aksi: 'REGISTRASI_NRP_GAGAL',
          nrp_saksi: nrpInput,
          keterangan: `Percobaan registrasi gagal: NRP ${nrpInput} tidak ditemukan`
        });
        await sendMessage(chatId, `❌ <b>NRP TIDAK TERDAFTAR. SILAHKAN HUBUNGI ADMIN</b>`);
        return res.status(200).json({ ok: true });
      }

      await supabase.from('master_petugas').update({ chat_id_telegram: `WAIT_${chatId}` }).eq('nrp', nrpInput);

      await logAktivitas({
        jenis_aksi: 'REGISTRASI_NRP_FOUND',
        nrp_saksi: masterP.nrp,
        nama_saksi: masterP.nama_petugas,
        kecamatan: masterP.kecamatan,
        desa: masterP.desa,
        keterangan: `Verifikasi NRP ${masterP.nrp} berhasil, menunggu verifikasi PIN`
      });

      await sendMessage(chatId, `✅ <b>NRP TERVERIFIKASI</b>\n\nHalo <b>${escapeHtml(masterP.nama_petugas)}</b>.\n\nNRP Anda berhasil ditemukan dalam database.\n\nSilakan masukkan <b>PIN Rahasia</b> Anda.\n\nJika ingin membatalkan:\n/batal`);
      return res.status(200).json({ ok: true });
    }

    if (!petugas) {
      await sendMessage(chatId, `🔐 <b>ANDA BELUM TERDAFTAR</b>\n\nSilakan registrasi terlebih dahulu:\n<code>/reg NRP</code>\n\nAtau ketik /help untuk panduan.`);
      return res.status(200).json({ ok: true });
    }

    if (command === '/status' || command.startsWith('/status@')) {
      const { data: allTps } = await supabase.from('master_desa').select('tps').eq('kecamatan', petugas.kecamatan).eq('desa', petugas.desa).order('tps');
      const { data: allHasil } = await supabase.from('hasil_suara').select('tps, status_verifikasi').eq('kecamatan', petugas.kecamatan).eq('desa', petugas.desa);

      const statusMap = {};
      allHasil?.forEach(h => { statusMap[h.tps] = h.status_verifikasi; });

      let rincianStatus = '';
      allTps?.forEach(t => {
        const st = statusMap[t.tps] || 'BELUM ADA HASIL DIINPUT';
        rincianStatus += `TPS ${t.tps} : ${st}\n`;
      });

      const msg = `👤 <b>STATUS ANDA</b>\n\n` +
        `Nama : ${escapeHtml(petugas.nama_petugas)}\n` +
        `NRP : ${escapeHtml(petugas.nrp)}\n` +
        `Kecamatan : ${escapeHtml(petugas.kecamatan)}\n` +
        `Desa : ${escapeHtml(petugas.desa)}\n` +
        `TPS Aktif : ${escapeHtml(petugas.tps_aktif || '-')}\n\n` +
        rincianStatus;

      await sendMessage(chatId, msg);
      return res.status(200).json({ ok: true });
    }

    /* =========================================================
       PERINTAH /LIHATHASIL
    ========================================================= */
    if (command === '/lihathasil' || command.startsWith('/lihathasil@')) {
      const { data: allTps } = await supabase
        .from('master_desa')
        .select('tps, jumlah_calon')
        .eq('kecamatan', petugas.kecamatan)
        .eq('desa', petugas.desa)
        .order('tps');

      const { data: allHasil } = await supabase
        .from('hasil_suara')
        .select('*')
        .eq('kecamatan', petugas.kecamatan)
        .eq('desa', petugas.desa);

      const statusMap = {};
      allHasil?.forEach(h => { statusMap[h.tps] = h; });

      const jumlahCalon = allTps?.[0]?.jumlah_calon || 2;
      const tpsList = allTps?.map(t => t.tps) || [];

      let header = 'Calon      | ' + tpsList.map(t => `TPS ${t}`).join(' | ');
      let separator = '='.repeat(Math.max(25, header.length));

      let bodyRows = [];
      for (let i = 1; i <= jumlahCalon; i++) {
        const numStr = String(i).padStart(2, '0');
        const key = `suara_calon_${numStr}`;
        let vals = tpsList.map(t => {
          const h = statusMap[t];
          return h && h[key] !== null && h[key] !== undefined ? h[key] : '-';
        });
        bodyRows.push(`Calon ${numStr}   | ` + vals.join('     | '));
      }

      let tsVals = tpsList.map(t => {
        const h = statusMap[t];
        return h && h.suara_tidak_sah !== null && h.suara_tidak_sah !== undefined ? h.suara_tidak_sah : '-';
      });
      let tsRow = `Tidak sah  | ` + tsVals.join('     | ');

      let totVals = tpsList.map(t => {
        const h = statusMap[t];
        return h && h.total_suara_masuk !== null && h.total_suara_masuk !== undefined ? h.total_suara_masuk : '-';
      });
      let totRow = `TOTAL      | ` + totVals.join('     | ');

      let tableText = `${header}\n${separator}\n${bodyRows.join('\n')}\n\n${tsRow}\n${separator}\n${totRow}`;
      const msg = `📊<b>HASIL SUARA DICATAT DESA ${escapeHtml(petugas.desa).toUpperCase()}</b>\n\n<pre>${tableText}</pre>`;

      await sendMessage(chatId, msg);
      return res.status(200).json({ ok: true });
    }

    if (command === '/kirimhasil' || command === '/edithasil') {
      const isEditMode = command === '/edithasil';
      await supabase.from('master_petugas').update({ mode_input: isEditMode ? 'EDIT' : 'KIRIM' }).eq('nrp', petugas.nrp);

      await logAktivitas({
        jenis_aksi: isEditMode ? 'MODE_EDIT_HASIL' : 'MODE_KIRIM_HASIL',
        nrp_saksi: petugas.nrp,
        nama_saksi: petugas.nama_petugas,
        kecamatan: petugas.kecamatan,
        desa: petugas.desa,
        keterangan: `Petugas membuka menu ${command}`
      });

      const { data: allTps } = await supabase.from('master_desa').select('tps').eq('kecamatan', petugas.kecamatan).eq('desa', petugas.desa).order('tps');
      const { data: filledHasil } = await supabase.from('hasil_suara').select('tps').eq('kecamatan', petugas.kecamatan).eq('desa', petugas.desa);

      const filledSet = new Set(filledHasil?.map(h => h.tps));

      if (!isEditMode && allTps && allTps.every(t => filledSet.has(t.tps))) {
        await sendMessage(chatId, `SELURUH TPS SUDAH TERISI DATA. UNTUK EDIT DATA kirim /edithasil`);
        return res.status(200).json({ ok: true });
      }

      const availableTps = isEditMode ? allTps : allTps.filter(t => !filledSet.has(t.tps));
      const keyboard = availableTps.map(t => [{ text: `📍 TPS ${t.tps}` }]);

      const msg = `📋 <b>PANDUAN PELAPORAN HASIL SUARA</b>\n\n` +
        `Langkah 1:\nSilakan pilih TPS.\n\n` +
        `Langkah 2:\nMasukkan jumlah suara sesuai contoh format yang diberikan.`;

      await sendMessage(chatId, msg, { keyboard, resize_keyboard: true, one_time_keyboard: true });
      return res.status(200).json({ ok: true });
    }

    if (command === '/kirimplano') {
      await supabase.from('master_petugas').update({ mode_input: 'PLANO' }).eq('nrp', petugas.nrp);
      
      await logAktivitas({
        jenis_aksi: 'MODE_KIRIM_PLANO',
        nrp_saksi: petugas.nrp,
        nama_saksi: petugas.nama_petugas,
        kecamatan: petugas.kecamatan,
        desa: petugas.desa,
        keterangan: `Petugas membuka menu /kirimplano`
      });

      const { data: allTps } = await supabase.from('master_desa').select('tps').eq('kecamatan', petugas.kecamatan).eq('desa', petugas.desa).order('tps');
      const keyboard = allTps?.map(t => [{ text: `📍 TPS ${t.tps}` }]);

      await sendMessage(chatId, `📷 <b>PILIH TPS UNTUK UPLOAD PLANO</b>`, { keyboard, resize_keyboard: true, one_time_keyboard: true });
      return res.status(200).json({ ok: true });
    }

    if (Array.isArray(message.photo) && message.photo.length > 0) {
      if (!petugas.tps_aktif) {
        await sendMessage(chatId, `⚠️ TPS belum dipilih. Ketik /kirimplano atau /kirimhasil terlebih dahulu.`);
        return res.status(200).json({ ok: true });
      }

      const largestPhoto = message.photo[message.photo.length - 1];

      // Cek apakah foto plano untuk TPS ini sudah pernah diunggah sebelumnya
      const { data: cekHasil } = await supabase
        .from('hasil_suara')
        .select('*')
        .eq('kecamatan', petugas.kecamatan)
        .eq('desa', petugas.desa)
        .eq('tps', petugas.tps_aktif)
        .maybeSingle();

      if (cekHasil && (cekHasil.telegram_photo_file_id || cekHasil.status_verifikasi !== 'PLANO BELUM TERUNGGAH')) {
        // [PEMBENAHAN] Simpan file_id ke catatan_verifikasi di tabel hasil_suara agar tidak ada batasan panjang karakter
        await supabase.from('hasil_suara').update({
          catatan_verifikasi: `PENDING_REPLACE_${largestPhoto.file_id}`
        }).eq('id', cekHasil.id);

        const keyboard = {
          inline_keyboard: [
            [{ text: '⚠️ YA, TIMPA / REPLACE FOTO', callback_data: 'REPLACE_PLANO_YES' }],
            [{ text: '❌ BATAL', callback_data: 'REPLACE_PLANO_NO' }]
          ]
        };
        await sendMessage(chatId, `⚠️ <b>PERHATIAN</b>\n\nFoto C1 Plano untuk <b>TPS ${petugas.tps_aktif}</b> sudah pernah diunggah sebelumnya.\nApakah Anda ingin mengganti/menimpa foto lama dengan yang baru?`, keyboard);
        return res.status(200).json({ ok: true });
      }

      await sendMessage(chatId, `📷 Foto C1 Plano TPS ${petugas.tps_aktif} diterima dan sedang diproses di latar belakang.`);
      waitUntil(processPlanoPhotoInBackground(chatId, petugas.tps_aktif, largestPhoto.file_id, petugas));
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('📍 TPS')) {
      const tpsSelected = text.replace('📍 TPS', '').trim();
      await supabase.from('master_petugas').update({ tps_aktif: tpsSelected }).eq('nrp', petugas.nrp);

      await logAktivitas({
        jenis_aksi: 'PILIH_TPS',
        nrp_saksi: petugas.nrp,
        nama_saksi: petugas.nama_petugas,
        kecamatan: petugas.kecamatan,
        desa: petugas.desa,
        tps: tpsSelected,
        keterangan: `Petugas memilih TPS ${tpsSelected} (Mode: ${petugas.mode_input || 'KIRIM'})`
      });

      const { data: mDesa } = await supabase.from('master_desa').select('jumlah_calon').eq('kecamatan', petugas.kecamatan).eq('desa', petugas.desa).eq('tps', tpsSelected).maybeSingle();
      const jumlahCalon = mDesa?.jumlah_calon || 2;

      if (petugas.mode_input === 'PLANO') {
        await removeKeyboard(chatId, `📌 <b>TPS ${tpsSelected} TERPILIH</b>\n\nSilakan kirimkan <b>foto C1 Plano</b>.`);
      } else {
        const example = Array(jumlahCalon).fill('0').concat(['0']).join('#');
        await removeKeyboard(chatId, `📌 <b>TPS ${tpsSelected} TERPILIH</b>\n\nSilakan masukkan suara dengan format:\n<code>${example}</code>`);
      }
      return res.status(200).json({ ok: true });
    }

    if (text.includes('#')) {
      const tpsTarget = petugas.tps_aktif;
      if (!tpsTarget) {
        await sendMessage(chatId, `⚠️ Pilih TPS terlebih dahulu.`);
        return res.status(200).json({ ok: true });
      }

      const { data: mDesa } = await supabase.from('master_desa').select('jumlah_calon, total_dpt, dpt').eq('kecamatan', petugas.kecamatan).eq('desa', petugas.desa).eq('tps', tpsTarget).maybeSingle();
      const jumlahCalon = mDesa?.jumlah_calon || 2;
      const dptLimit = Number(mDesa?.total_dpt ?? mDesa?.dpt ?? 9999);

      const parsed = parseVoteInput(text, jumlahCalon);
      if (parsed.error) {
        await sendMessage(chatId, `❌ ${parsed.error}`);
        return res.status(200).json({ ok: true });
      }

      const vote = parsed.result;

      if (vote.total > dptLimit) {
        await sendMessage(chatId, `❌ TOTAL SUARA MELEBIHI DPT (${dptLimit}). SILAHKAN INPUT KEMBALI`);
        return res.status(200).json({ ok: true });
      }

      const keyboard = {
        inline_keyboard: [
          [{ text: 'BENAR DAN KIRIM', callback_data: `CONFIRM_VOTE_${tpsTarget}_${text}` }],
          [{ text: 'REVISI HASIL SUARA', callback_data: `REVISE_VOTE` }]
        ]
      };

      const msg = `📊 <b>HASIL SUARA DITERIMA</b>\n\n${buildSummaryText(tpsTarget, vote, jumlahCalon)}`;
      await sendMessage(chatId, msg, keyboard);
      return res.status(200).json({ ok: true });
    }

    await sendMessage(chatId, `ℹ️ Perintah tidak dikenali. Ketik /help untuk daftar menu.`);
    return res.status(200).json({ ok: true });

  } catch (error) {
    console.error('GLOBAL ERROR:', error);
    return res.status(200).json({ ok: true });
  }
}

/* =========================================================
   CALLBACK QUERY HANDLER (BUTTON ACTIONS)
========================================================= */

async function handleCallback(cb) {
  const chatId = String(cb.message.chat.id);
  const data = cb.data;
  await answerCallbackQuery(cb.id);

  const { data: petugas } = await supabase.from('master_petugas').select('*').eq('chat_id_telegram', chatId).maybeSingle();
  if (!petugas) return;

  if (data === 'REPLACE_PLANO_YES') {
    const { data: cekHasil } = await supabase
      .from('hasil_suara')
      .select('*')
      .eq('kecamatan', petugas.kecamatan)
      .eq('desa', petugas.desa)
      .eq('tps', petugas.tps_aktif)
      .maybeSingle();

    if (!cekHasil || !cekHasil.catatan_verifikasi || !cekHasil.catatan_verifikasi.startsWith('PENDING_REPLACE_')) {
      await editMessage(chatId, cb.message.message_id, `❌ Sesi unggah foto kedaluwarsa atau tidak valid. Silakan kirim ulang foto.`);
      return;
    }

    const fileId = cekHasil.catatan_verifikasi.replace('PENDING_REPLACE_', '');
    
    // Bersihkan catatan verifikasi sementara
    await supabase.from('hasil_suara').update({ catatan_verifikasi: null }).eq('id', cekHasil.id);

    await editMessage(chatId, cb.message.message_id, `🔄 Mengganti foto C1 Plano TPS ${petugas.tps_aktif} dengan yang baru...`);
    waitUntil(processPlanoPhotoInBackground(chatId, petugas.tps_aktif, fileId, petugas));
    return;
  }

  if (data === 'REPLACE_PLANO_NO') {
    const { data: cekHasil } = await supabase
      .from('hasil_suara')
      .select('*')
      .eq('kecamatan', petugas.kecamatan)
      .eq('desa', petugas.desa)
      .eq('tps', petugas.tps_aktif)
      .maybeSingle();

    if (cekHasil) {
      await supabase.from('hasil_suara').update({ catatan_verifikasi: null }).eq('id', cekHasil.id);
    }

    await editMessage(chatId, cb.message.message_id, `❌ Unggah foto plano dibatalkan.`);
    return;
  }

  if (data.startsWith('CONFIRM_VOTE_')) {
    const parts = data.split('_');
    const tpsTarget = parts[2];
    const voteText = parts[3];

    const { data: mDesa } = await supabase.from('master_desa').select('jumlah_calon').eq('kecamatan', petugas.kecamatan).eq('desa', petugas.desa).eq('tps', tpsTarget).maybeSingle();
    const jumlahCalon = mDesa?.jumlah_calon || 2;
    const vote = parseVoteInput(voteText, jumlahCalon).result;

    const { data: existingHasil } = await supabase.from('hasil_suara').select('*').eq('kecamatan', petugas.kecamatan).eq('desa', petugas.desa).eq('tps', tpsTarget).maybeSingle();

    let statusVerifikasi = 'PLANO BELUM TERUNGGAH';
    if (existingHasil?.telegram_photo_file_id) {
      statusVerifikasi = 'FOTO PLANO BELUM TERVERIFIKASI';
    }

    const votePayload = {
      kecamatan: petugas.kecamatan,
      desa: petugas.desa,
      tps: tpsTarget,
      nrp_saksi: petugas.nrp,
      nama_saksi: petugas.nama_petugas,
      suara_calon_01: vote.calon_01,
      suara_calon_02: vote.calon_02,
      suara_calon_03: vote.calon_03,
      suara_calon_04: vote.calon_04,
      suara_calon_05: vote.calon_05,
      suara_tidak_sah: vote.tidak_sah,
      total_suara_masuk: vote.total,
      input_format: voteText,
      status_verifikasi: statusVerifikasi,
      chat_id_saksi: chatId,
      timestamp: new Date().toISOString()
    };

    let saveErr = null;
    if (existingHasil) {
      const { error } = await supabase.from('hasil_suara').update(votePayload).eq('id', existingHasil.id);
      saveErr = error;
    } else {
      const { error } = await supabase.from('hasil_suara').insert(votePayload);
      saveErr = error;
    }

    if (saveErr) {
      console.error('FAILED TO SAVE VOTE:', saveErr);
      await sendMessage(chatId, `❌ Gagal menyimpan data: ${saveErr.message}`);
      return;
    }

    await logAktivitas({
      jenis_aksi: existingHasil ? 'EDIT_HASIL' : 'KIRIM_HASIL_AWAL',
      nrp_saksi: petugas.nrp,
      nama_saksi: petugas.nama_petugas,
      kecamatan: petugas.kecamatan,
      desa: petugas.desa,
      tps: tpsTarget,
      data_sebelum: existingHasil ? {
        suara_calon_01: existingHasil.suara_calon_01,
        suara_calon_02: existingHasil.suara_calon_02,
        suara_calon_03: existingHasil.suara_calon_03,
        suara_calon_04: existingHasil.suara_calon_04,
        suara_calon_05: existingHasil.suara_calon_05,
        suara_tidak_sah: existingHasil.suara_tidak_sah,
        total_suara_masuk: existingHasil.total_suara_masuk,
        status_verifikasi: existingHasil.status_verifikasi
      } : null,
      data_sesudah: {
        suara_calon_01: vote.calon_01,
        suara_calon_02: vote.calon_02,
        suara_calon_03: vote.calon_03,
        suara_calon_04: vote.calon_04,
        suara_calon_05: vote.calon_05,
        suara_tidak_sah: vote.tidak_sah,
        total_suara_masuk: vote.total,
        status_verifikasi: statusVerifikasi
      },
      keterangan: existingHasil
        ? `Edit perolehan suara TPS ${tpsTarget} oleh ${petugas.nama_petugas}`
        : `Pengiriman awal hasil suara TPS ${tpsTarget} oleh ${petugas.nama_petugas}`
    });

    const msg = `📊 <b>HASIL SUARA DICATAT</b>\n\n${buildSummaryText(tpsTarget, vote, jumlahCalon)}`;
    const keyboard = { inline_keyboard: [[{ text: 'Kirim Hasil TPS Lain', callback_data: 'NEXT_TPS' }]] };

    await editMessage(chatId, cb.message.message_id, msg, keyboard);
    return;
  }

  if (data === 'REVISE_VOTE') {
    await logAktivitas({
      jenis_aksi: 'REVISI_INPUT_HASIL',
      nrp_saksi: petugas.nrp,
      nama_saksi: petugas.nama_petugas,
      kecamatan: petugas.kecamatan,
      desa: petugas.desa,
      tps: petugas.tps_aktif,
      keterangan: `Petugas memilih merevisi konfirmasi angka hasil suara`
    });

    await editMessage(chatId, cb.message.message_id, `🔄 Silakan masukkan ulang angka hasil suara sesuai format.`);
    return;
  }

  if (data === 'NEXT_TPS') {
    const { data: allTps } = await supabase.from('master_desa').select('tps').eq('kecamatan', petugas.kecamatan).eq('desa', petugas.desa).order('tps');
    const { data: filledHasil } = await supabase.from('hasil_suara').select('tps').eq('kecamatan', petugas.kecamatan).eq('desa', petugas.desa);
    const filledSet = new Set(filledHasil?.map(h => h.tps));

    const availableTps = allTps?.filter(t => !filledSet.has(t.tps));
    if (!availableTps || availableTps.length === 0) {
      await sendMessage(chatId, `SELURUH TPS SUDAH TERISI DATA. UNTUK EDIT DATA kirim /edithasil`);
      return;
    }

    const keyboard = availableTps.map(t => [{ text: `📍 TPS ${t.tps}` }]);
    await sendMessage(chatId, `📋 <b>PILIH TPS LAIN:</b>`, { keyboard, resize_keyboard: true, one_time_keyboard: true });
    return;
  }

if (data.startsWith('USE_MANUAL_')) {
  const id = data.replace('USE_MANUAL_', '');

  const { data: hLama, error: hError } = await supabase
    .from('hasil_suara')
    .select('*')
    .eq('id', id)
    .single();

  if (hError || !hLama) {
    await answerCallbackQuery(
      cb.id,
      'Data TPS tidak ditemukan.'
    );
    return;
  }

  const { error: updateError } = await supabase
    .from('hasil_suara')
    .update({
      status_verifikasi: 'MEMERLUKAN VERIFIKASI ADMIN'
    })
    .eq('id', id);

  if (updateError) {
    console.error(
      '[ADMIN] Gagal mengubah status:',
      updateError.message
    );

    await answerCallbackQuery(
      cb.id,
      'Gagal mengirim ke verifikasi admin.'
    );

    return;
  }

  await logAktivitas({
    jenis_aksi: 'PILIH_HASIL_MANUAL',
    nrp_saksi: petugas.nrp,
    nama_saksi: petugas.nama_petugas,
    kecamatan: petugas.kecamatan,
    desa: petugas.desa,
    tps: hLama.tps,

    data_sebelum: {
      status_verifikasi: hLama.status_verifikasi
    },

    data_sesudah: {
      status_verifikasi: 'MEMERLUKAN VERIFIKASI ADMIN',
      sumber_pilihan: 'INPUT_MANUAL'
    },

    keterangan:
      `Saksi memilih menggunakan Hasil Input Manual pada TPS ${hLama.tps}`
  });

  await editMessage(
    chatId,
    cb.message.message_id,
    `✅ Anda memilih menggunakan <b>Hasil Input Manual</b>.\n\n` +
    `TPS ${escapeHtml(hLama.tps)} telah dikirim ke antrean verifikasi Admin.`
  );

  return;
}

}
