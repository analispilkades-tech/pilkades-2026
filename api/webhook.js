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
const MAX_CALON = 5;
const MIN_OCR_CONFIDENCE = 90;

/* =========================================================
   UTILITAS
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
  return String(text || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)[0];
}

async function telegramApi(method, payload = {}) {
  if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN belum tersedia di environment variables.');
  }

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    console.error(`Telegram API ERROR ${method}:`, JSON.stringify(result));
    throw new Error(result?.description || `Telegram API ${method} gagal.`);
  }

  return result;
}

async function sendMessage(chatId, text, replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML'
  };

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
    return await telegramApi('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false
    });
  } catch (error) {
    console.error('ANSWER CALLBACK ERROR:', error?.message || error);
    return null;
  }
}

async function editMessage(chatId, messageId, text, replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML'
  };

  if (replyMarkup) payload.reply_markup = replyMarkup;

  try {
    return await telegramApi('editMessageText', payload);
  } catch (error) {
    console.error('EDIT MESSAGE ERROR:', error?.message || error);
    return null;
  }
}

async function removeKeyboard(chatId, text) {
  return sendMessage(chatId, text, { remove_keyboard: true });
}

/* =========================================================
   TELEGRAM PHOTO
========================================================= */

async function getTelegramFile(fileId) {
  const result = await telegramApi('getFile', { file_id: fileId });
  return result.result;
}

async function downloadTelegramFile(filePath) {
  const response = await fetch(
    `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`
  );

  if (!response.ok) {
    throw new Error(`Gagal mengambil file Telegram. HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/* =========================================================
   TESSERACT.JS OCR WITH TIMEOUT PROTECTION
========================================================= */

let cachedCoreVersion = null;

function getTesseractCoreVersion() {
  if (cachedCoreVersion) return cachedCoreVersion;

  try {
    cachedCoreVersion = require('tesseract.js-core/package.json').version;
  } catch (error) {
    console.error('GAGAL MEMBACA VERSI tesseract.js-core:', error?.message || error);
    cachedCoreVersion = null;
  }

  return cachedCoreVersion;
}

async function runOCR(imageBuffer) {
  let worker = null;

  // Timeout Pengaman OCR (12 Detik Max)
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('OCR Timeout Exceeded')), 12000)
  );

  const ocrProcess = async () => {
    console.log('OCR TESSERACT: MEMULAI');
    const coreVersion = getTesseractCoreVersion();

    const workerOptions = {
      corePath: coreVersion
        ? `https://cdn.jsdelivr.net/npm/tesseract.js-core@${coreVersion}`
        : 'https://cdn.jsdelivr.net/npm/tesseract.js-core',
      cachePath: '/tmp'
    };

    worker = await createWorker('eng', 1, workerOptions);

    await worker.setParameters({
      tessedit_char_whitelist:
        '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz:-/#.',
      preserve_interword_spaces: '1'
    });

    const result = await worker.recognize(imageBuffer);
    const text = result?.data?.text || '';
    const confidence = Number(result?.data?.confidence || 0);

    return { text, confidence, raw: result?.data || null };
  };

  try {
    return await Promise.race([ocrProcess(), timeoutPromise]);
  } finally {
    if (worker) {
      try {
        await worker.terminate();
      } catch (error) {
        console.error('GAGAL TERMINATE OCR WORKER:', error?.message || error);
      }
    }
  }
}

/* =========================================================
   PARSER & COMPARISON
========================================================= */

function extractLabeledNumber(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1] !== undefined) {
      const number = parseInt(String(match[1]).replace(/[^\d]/g, ''), 10);
      if (Number.isInteger(number)) return number;
    }
  }
  return null;
}

function parseOCRVotes(ocrText, jumlahCalon) {
  const normalized = String(ocrText || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .toUpperCase();

  const result = {
    calon_01: null,
    calon_02: null,
    calon_03: null,
    calon_04: null,
    calon_05: null,
    tidak_sah: null
  };

  for (let i = 1; i <= jumlahCalon; i++) {
    const number = String(i).padStart(2, '0');
    const patterns = [
      new RegExp(`CALON\\s*${number}\\D{0,15}(\\d{1,5})`, 'i'),
      new RegExp(`CALON\\s*${i}\\D{0,15}(\\d{1,5})`, 'i'),
      new RegExp(`C\\s*${number}\\D{0,15}(\\d{1,5})`, 'i'),
      new RegExp(`C\\s*${i}\\D{0,15}(\\d{1,5})`, 'i')
    ];
    result[`calon_${number}`] = extractLabeledNumber(normalized, patterns);
  }

  result.tidak_sah = extractLabeledNumber(normalized, [
    /SUARA\s+TIDAK\s+SAH\D{0,15}(\d{1,5})/i,
    /TIDAK\s+SAH\D{0,15}(\d{1,5})/i,
    /TIDAKSAH\D{0,15}(\d{1,5})/i
  ]);

  let found = 0;
  for (let i = 1; i <= jumlahCalon; i++) {
    const key = `calon_${String(i).padStart(2, '0')}`;
    if (result[key] !== null && Number.isInteger(result[key])) found++;
  }

  const allCandidatesFound = found === jumlahCalon;
  const tidakSahFound = result.tidak_sah !== null;

  let confidence = 0;
  if (allCandidatesFound) confidence += 70;
  if (tidakSahFound) confidence += 20;
  if (normalized.includes('JUMLAH') || normalized.includes('TOTAL')) confidence += 10;

  return {
    ...result,
    confidence,
    complete: allCandidatesFound && tidakSahFound
  };
}

function compareVotes(input, ocr, jumlahCalon) {
  const differences = [];
  for (let i = 1; i <= jumlahCalon; i++) {
    const number = String(i).padStart(2, '0');
    const key = `calon_${number}`;
    const inputValue = Number(input[key] || 0);
    const ocrValue = Number(ocr[key] ?? -1);

    if (inputValue !== ocrValue) {
      differences.push({ label: `Calon ${number}`, input: inputValue, ocr: ocrValue });
    }
  }

  const inputTidakSah = Number(input.tidak_sah || 0);
  const ocrTidakSah = Number(ocr.tidak_sah ?? -1);

  if (inputTidakSah !== ocrTidakSah) {
    differences.push({ label: 'Tidak Sah', input: inputTidakSah, ocr: ocrTidakSah });
  }

  return { matched: differences.length === 0, differences };
}

function parseVoteInput(text, jumlahCalon) {
  const parts = String(text).split('#').map((val) => val.trim());
  const expected = jumlahCalon + 1;

  if (parts.length !== expected) {
    return {
      error: `Format membutuhkan ${expected} angka (${jumlahCalon} calon + suara tidak sah).`
    };
  }

  if (parts.some((val) => val === '' || !/^\d+$/.test(val))) {
    return { error: 'Semua nilai harus berupa angka positif.' };
  }

  const values = parts.map((val) => parseInt(val, 10));
  const result = {
    calon_01: 0, calon_02: 0, calon_03: 0, calon_04: 0, calon_05: 0,
    tidak_sah: values[values.length - 1]
  };

  for (let i = 0; i < jumlahCalon; i++) {
    result[`calon_${String(i + 1).padStart(2, '0')}`] = values[i];
  }

  result.total = values.reduce((sum, val) => sum + val, 0);
  return { error: null, result };
}

function buildVoteInputFromRow(row) {
  return {
    calon_01: Number(row.suara_calon_01 || 0),
    calon_02: Number(row.suara_calon_02 || 0),
    calon_03: Number(row.suara_calon_03 || 0),
    calon_04: Number(row.suara_calon_04 || 0),
    calon_05: Number(row.suara_calon_05 || 0),
    tidak_sah: Number(row.suara_tidak_sah || 0)
  };
}

async function findPendingReport(chatId) {
  const { data, error } = await supabase
    .from('hasil_suara')
    .select('*')
    .eq('chat_id_saksi', chatId)
    .in('status_verifikasi', ['WAITING_C1', 'OCR_PROCESSING', 'WAITING_USER_CONFIRMATION', 'WAITING_ADMIN'])
    .order('timestamp', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) console.error('ERROR FIND PENDING:', error);
  return data;
}

function buildVoteSummary(row, jumlahCalon) {
  let text = '';
  for (let i = 1; i <= jumlahCalon; i++) {
    const key = `suara_calon_${String(i).padStart(2, '0')}`;
    text += `• Calon ${String(i).padStart(2, '0')}: <b>${Number(row[key] || 0)}</b>\n`;
  }
  text += `• Tidak Sah: <b>${Number(row.suara_tidak_sah || 0)}</b>\n`;
  text += `-------------------------\n• <b>Total Suara Masuk: ${Number(row.total_suara_masuk || 0)}</b>`;
  return text;
}

/* =========================================================
   HANDLER FOTO C1 (PROSES LATAR BELAKANG VIA waitUntil)
========================================================= */

async function handlePhoto(message, petugasLogin) {
  const chatId = String(message.chat.id);
  const pending = await findPendingReport(chatId);

  if (!pending) {
    await sendMessage(
      chatId,
      `⚠️ <b>BELUM ADA DATA SUARA</b>\n\nKirim angka hasil suara terlebih dahulu (Contoh: <code>120#75#5</code>).`
    );
    return;
  }

  const photos = Array.isArray(message.photo) ? message.photo : [];
  if (photos.length === 0) {
    await sendMessage(chatId, `❌ Foto tidak dapat dibaca oleh sistem.`);
    return;
  }

  const largestPhoto = photos[photos.length - 1];
  const fileId = largestPhoto.file_id;
  const fileUniqueId = largestPhoto.file_unique_id;

  await supabase
    .from('hasil_suara')
    .update({
      status_verifikasi: 'OCR_PROCESSING',
      telegram_photo_file_id: fileId,
      telegram_photo_file_unique_id: fileUniqueId,
      ocr_processed_at: null
    })
    .eq('id', pending.id);

  await sendMessage(
    chatId,
    `📷 <b>FOTO C1 DITERIMA</b>\n\nFoto sedang diperiksa oleh sistem OCR di latar belakang. Mohon tunggu...`
  );

  try {
    const telegramFile = await getTelegramFile(fileId);
    if (!telegramFile?.file_path) throw new Error('Telegram tidak memberikan file_path.');

    const imageBuffer = await downloadTelegramFile(telegramFile.file_path);
    const ocr = await runOCR(imageBuffer);
    const ocrText = ocr.text || '';

    const { data: masterDesa } = await supabase
      .from('master_desa')
      .select('jumlah_calon')
      .eq('kecamatan', pending.kecamatan)
      .eq('desa', pending.desa)
      .eq('tps', pending.tps)
      .maybeSingle();

    const jumlahCalon = Math.min(
      Math.max(Number(masterDesa?.jumlah_calon || 2), 1),
      MAX_CALON
    );

    const parsed = parseOCRVotes(ocrText, jumlahCalon);

    const ocrUpdate = {
      ocr_text: ocrText,
      ocr_calon_01: parsed.calon_01,
      ocr_calon_02: parsed.calon_02,
      ocr_calon_03: parsed.calon_03,
      ocr_calon_04: parsed.calon_04,
      ocr_calon_05: parsed.calon_05,
      ocr_tidak_sah: parsed.tidak_sah,
      ocr_total_suara: [
        parsed.calon_01, parsed.calon_02, parsed.calon_03,
        parsed.calon_04, parsed.calon_05, parsed.tidak_sah
      ]
        .filter((val) => Number.isInteger(val))
        .reduce((sum, val) => sum + val, 0),
      ocr_confidence: parsed.confidence,
      ocr_engine: 'TESSERACT.JS',
      ocr_status: parsed.complete ? 'COMPLETE' : 'INCOMPLETE',
      ocr_processed_at: new Date().toISOString()
    };

    if (!parsed.complete) {
      await supabase
        .from('hasil_suara')
        .update({ ...ocrUpdate, status_verifikasi: 'WAITING_ADMIN' })
        .eq('id', pending.id);

      await sendMessage(
        chatId,
        `⚠️ <b>OCR MEMERLUKAN VERIFIKASI ADMIN</b>\n\nFoto diterima, tetapi angka tidak terbaca sempurna.\n📍 TPS: <b>${escapeHtml(pending.tps)}</b>`
      );
      return;
    }

    const input = buildVoteInputFromRow(pending);
    const comparison = compareVotes(input, parsed, jumlahCalon);

    if (comparison.matched && parsed.confidence >= MIN_OCR_CONFIDENCE) {
      await supabase
        .from('hasil_suara')
        .update({
          ...ocrUpdate,
          status_verifikasi: 'WAITING_USER_CONFIRMATION',
          user_confirmation: 'PENDING_MATCH_CONFIRMATION',
          catatan_verifikasi: 'OCR cocok dengan input. Menunggu konfirmasi.'
        })
        .eq('id', pending.id);

      const keyboard = {
        inline_keyboard: [
          [{ text: '✅ YA, HASIL FOTO BENAR', callback_data: `OCR_MATCH_CONFIRM_${pending.id}` }],
          [{ text: '🔄 PERIKSA ULANG FOTO', callback_data: `OCR_MATCH_RECHECK_${pending.id}` }],
          [{ text: '👨‍💼 KIRIM KE ADMIN', callback_data: `OCR_MATCH_ADMIN_${pending.id}` }]
        ]
      };

      await sendMessage(
        chatId,
        `✅ <b>HASIL FOTO SESUAI</b>\n\nHasil OCR <b>sama</b> dengan input Anda.\n📍 TPS: <b>${escapeHtml(pending.tps)}</b>\n\n` +
          buildVoteSummary(pending, jumlahCalon) +
          `\n\nApakah hasil ini benar?`,
        keyboard
      );
      return;
    }

    await supabase
      .from('hasil_suara')
      .update({ ...ocrUpdate, status_verifikasi: 'WAITING_USER_CONFIRMATION' })
      .eq('id', pending.id);

    let differenceText = '';
    for (const diff of comparison.differences) {
      differenceText += `• ${escapeHtml(diff.label)}: Input <b>${diff.input}</b> | C1 <b>${diff.ocr}</b>\n`;
    }

    const keyboard = {
      inline_keyboard: [
        [{ text: '✅ Gunakan Hasil C1', callback_data: `OCR_ACCEPT_${pending.id}` }],
        [{ text: '⚠️ Pertahankan Input → Admin', callback_data: `OCR_REJECT_${pending.id}` }]
      ]
    };

    await sendMessage(
      chatId,
      `⚠️ <b>PERBEDAAN DITEMUKAN</b>\n\n<b>PERBEDAAN:</b>\n${differenceText}\n\nSilakan tentukan tindakan:`,
      keyboard
    );
  } catch (error) {
    console.error('ERROR OCR FOTO:', error?.stack || error?.message || error);
    await supabase
      .from('hasil_suara')
      .update({
        status_verifikasi: 'WAITING_ADMIN',
        ocr_status: 'ERROR',
        ocr_engine: 'TESSERACT.JS',
        catatan_verifikasi: error?.message || 'OCR gagal diproses.'
      })
      .eq('id', pending.id);

    await sendMessage(
      chatId,
      `⚠️ <b>PEMERIKSAAN OTOMATIS GAGAL</b>\n\nData dialihkan ke <b>VERIFIKASI ADMIN</b>.`
    );
  }
}

/* =========================================================
   CALLBACK QUERY HANDLER
========================================================= */

async function handleCallbackQuery(callbackQuery) {
  const callbackId = callbackQuery.id;
  const data = callbackQuery.data || '';
  const message = callbackQuery.message;
  const chatId = String(message?.chat?.id || '');
  const messageId = message?.message_id;

  await answerCallbackQuery(callbackId);
  if (!chatId) return;

  if (data.startsWith('OCR_MATCH_CONFIRM_')) {
    const id = data.replace('OCR_MATCH_CONFIRM_', '');
    const { data: hasil } = await supabase
      .from('hasil_suara')
      .select('*')
      .eq('id', id)
      .eq('chat_id_saksi', chatId)
      .maybeSingle();

    if (!hasil || hasil.status_verifikasi !== 'WAITING_USER_CONFIRMATION') {
      await sendMessage(chatId, `ℹ️ Data tidak ditemukan atau sudah diproses.`);
      return;
    }

    await supabase
      .from('hasil_suara')
      .update({
        status_verifikasi: 'AUTO_VERIFIED',
        user_confirmation: 'CONFIRMED_BY_USER',
        user_confirmation_at: new Date().toISOString(),
        verified_by: 'BOT_OCR_USER_CONFIRMATION',
        verified_at: new Date().toISOString()
      })
      .eq('id', id);

    if (messageId) {
      await editMessage(chatId, messageId, `🎉 <b>VERIFIKASI BERHASIL</b>\n\nData masuk ke <b>LIVE COUNT</b>.`);
    } else {
      await sendMessage(chatId, `🎉 Data masuk ke <b>LIVE COUNT</b>.`);
    }
    return;
  }

  if (data.startsWith('OCR_MATCH_ADMIN_')) {
    const id = data.replace('OCR_MATCH_ADMIN_', '');
    await supabase
      .from('hasil_suara')
      .update({ status_verifikasi: 'WAITING_ADMIN', user_confirmation: 'SENT_TO_ADMIN' })
      .eq('id', id);

    if (messageId) {
      await editMessage(chatId, messageId, `👨‍💼 <b>DITERUSKAN KE ADMIN</b>\n\nMenunggu verifikasi Admin.`);
    }
    return;
  }

  if (data.startsWith('OCR_MATCH_RECHECK_')) {
    const id = data.replace('OCR_MATCH_RECHECK_', '');
    await supabase
      .from('hasil_suara')
      .update({ status_verifikasi: 'WAITING_C1', user_confirmation: 'RECHECK_PHOTO' })
      .eq('id', id);

    if (messageId) {
      await editMessage(chatId, messageId, `🔄 Silakan kirim ulang foto C1 Plano yang lebih jelas.`);
    }
    return;
  }

  if (data.startsWith('OCR_ACCEPT_')) {
    const id = data.replace('OCR_ACCEPT_', '');
    const { data: hasil } = await supabase.from('hasil_suara').select('*').eq('id', id).maybeSingle();

    if (!hasil) return;

    const ocr01 = Number(hasil.ocr_calon_01 || 0);
    const ocr02 = Number(hasil.ocr_calon_02 || 0);
    const ocr03 = Number(hasil.ocr_calon_03 || 0);
    const ocr04 = Number(hasil.ocr_calon_04 || 0);
    const ocr05 = Number(hasil.ocr_calon_05 || 0);
    const ocrTidakSah = Number(hasil.ocr_tidak_sah || 0);
    const total = ocr01 + ocr02 + ocr03 + ocr04 + ocr05 + ocrTidakSah;

    await supabase
      .from('hasil_suara')
      .update({
        suara_calon_01: ocr01, suara_calon_02: ocr02, suara_calon_03: ocr03,
        suara_calon_04: ocr04, suara_calon_05: ocr05, suara_tidak_sah: ocrTidakSah,
        total_suara_masuk: total, status_verifikasi: 'AUTO_VERIFIED',
        verified_by: 'USER_CONFIRMED_OCR', verified_at: new Date().toISOString()
      })
      .eq('id', id);

    if (messageId) {
      await editMessage(chatId, messageId, `✅ <b>HASIL C1 DIKONFIRMASI</b>\n\nData masuk ke livecount.`);
    }
    return;
  }

  if (data.startsWith('OCR_REJECT_')) {
    const id = data.replace('OCR_REJECT_', '');
    await supabase
      .from('hasil_suara')
      .update({ status_verifikasi: 'WAITING_ADMIN', user_confirmation: 'REJECT_OCR' })
      .eq('id', id);

    if (messageId) {
      await editMessage(chatId, messageId, `⚠️ Diteruskan ke Admin.`);
    }
    return;
  }
}

/* =========================================================
   HANDLER UTAMA (ENTRY POINT VERCEL)
========================================================= */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('OK - Pilkades Bot Active');
  }

  try {
    // Parsing aman untuk req.body string maupun object
    const update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    if (!update) return res.status(200).json({ ok: true });

    // Handle Callback Query
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
      return res.status(200).json({ ok: true });
    }

    const message = update.message;
    if (!message) return res.status(200).json({ ok: true });

    const chatId = String(message.chat?.id || '');
    const text = message.text ? String(message.text).trim() : '';

    if (!chatId) return res.status(200).json({ ok: true });

    // 1. FOTO TELEGRAM -> DIPROSES NATIVE VERCEL BACKGROUND VIA waitUntil()
    if (Array.isArray(message.photo) && message.photo.length > 0) {
      const { data: petugasFoto } = await supabase
        .from('master_petugas')
        .select('*')
        .eq('chat_id_telegram', chatId)
        .maybeSingle();

      if (!petugasFoto) {
        await sendMessage(
          chatId,
          `🔐 <b>ANDA BELUM TERDAFTAR</b>\n\nSilakan registrasi terlebih dahulu:\n<code>/reg NRP</code>`
        );
        return res.status(200).json({ ok: true });
      }

      // Kirim proses OCR ke background agar Vercel merespons 200 OK dalam <1 detik
      waitUntil(handlePhoto(message, petugasFoto));
      return res.status(200).json({ ok: true });
    }

    // 2. COMMAND TELEGRAM
    const command = commandOf(text);

    if (command === '/start' || command.startsWith('/start@')) {
      await sendMessage(
        chatId,
        `🇮🇩 <b>SELAMAT DATANG</b>\n\nBot Penghitungan Cepat Pilkades Wonosobo\n\nUntuk registrasi:\n<code>/reg NRP</code>`
      );
      return res.status(200).json({ ok: true });
    }

    if (command === '/batal' || command.startsWith('/batal@')) {
      const { data: petugasBatal } = await supabase
        .from('master_petugas')
        .select('*')
        .eq('chat_id_telegram', `WAIT_${chatId}`)
        .maybeSingle();

      if (petugasBatal) {
        await supabase
          .from('master_petugas')
          .update({ chat_id_telegram: null })
          .eq('nrp', petugasBatal.nrp);
      }

      await removeKeyboard(chatId, `✅ Proses dibatalkan.\nKetik <code>/start</code> untuk memulai.`);
      return res.status(200).json({ ok: true });
    }

    if (command === '/reg' || command.startsWith('/reg@')) {
      const parts = text.trim().split(/\s+/);
      const nrpInput = parts.length >= 2 ? parts[1].trim() : '';

      if (!nrpInput) {
        await sendMessage(chatId, `⚠️ <b>FORMAT SALAH</b>\nContoh: <code>/reg 89080060</code>`);
        return res.status(200).json({ ok: true });
      }

      const { data: petugas } = await supabase
        .from('master_petugas')
        .select('*')
        .eq('nrp', nrpInput)
        .maybeSingle();

      if (!petugas) {
        await sendMessage(chatId, `❌ <b>NRP TIDAK TERDAFTAR</b>`);
        return res.status(200).json({ ok: true });
      }

      await supabase
        .from('master_petugas')
        .update({ chat_id_telegram: `WAIT_${chatId}` })
        .eq('nrp', nrpInput);

      await sendMessage(
        chatId,
        `✅ Halo <b>${escapeHtml(petugas.nama_petugas)}</b>, silakan masukkan <b>PIN Rahasia</b> Anda:`
      );
      return res.status(200).json({ ok: true });
    }

    // CEK INPUT PIN
    const { data: petugasWait } = await supabase
      .from('master_petugas')
      .select('*')
      .eq('chat_id_telegram', `WAIT_${chatId}`)
      .maybeSingle();

    if (petugasWait) {
      if (text !== '' && text === String(petugasWait.pin ?? '').trim()) {
        await supabase
          .from('master_petugas')
          .update({ chat_id_telegram: chatId })
          .eq('nrp', petugasWait.nrp);

        await removeKeyboard(
          chatId,
          `🎉 <b>REGISTRASI BERHASIL</b>\n\nKetik <code>/kirimhasil</code> untuk melapor.`
        );
      } else {
        await sendMessage(chatId, `❌ <b>PIN SALAH</b>`);
      }
      return res.status(200).json({ ok: true });
    }

    // CEK LOGIN PETUGAS
    const { data: petugasLogin } = await supabase
      .from('master_petugas')
      .select('*')
      .eq('chat_id_telegram', chatId)
      .maybeSingle();

    if (!petugasLogin) {
      await sendMessage(chatId, `🔐 <b>ANDA BELUM TERDAFTAR</b>\nKetik: <code>/reg NRP</code>`);
      return res.status(200).json({ ok: true });
    }

    if (command === '/status' || command.startsWith('/status@')) {
      await sendMessage(
        chatId,
        `👤 <b>STATUS PETUGAS</b>\n\nNama: <b>${escapeHtml(petugasLogin.nama_petugas)}</b>\nNRP: <code>${escapeHtml(petugasLogin.nrp)}</code>`
      );
      return res.status(200).json({ ok: true });
    }

    if (command === '/kirimhasil' || command.startsWith('/kirimhasil@')) {
      const { data: daftarTps } = await supabase
        .from('master_desa')
        .select('tps')
        .eq('kecamatan', petugasLogin.kecamatan)
        .eq('desa', petugasLogin.desa)
        .order('tps');

      const keyboard = daftarTps?.length
        ? daftarTps.map((item) => [{ text: `📍 ${item.tps}` }])
        : [[{ text: '📍 TPS 01' }], [{ text: '📍 TPS 02' }]];

      await sendMessage(
        chatId,
        `📋 <b>PILIH TPS:</b>`,
        { keyboard, resize_keyboard: true, one_time_keyboard: true }
      );
      return res.status(200).json({ ok: true });
    }

    // PILIH TPS
    if (text.startsWith('📍') || /^tps\s*\d+/i.test(text)) {
      const tpsSelected = text.replace('📍', '').trim();
      const { data: masterDesa } = await supabase
        .from('master_desa')
        .select('tps,jumlah_calon')
        .eq('kecamatan', petugasLogin.kecamatan)
        .eq('desa', petugasLogin.desa)
        .eq('tps', tpsSelected)
        .maybeSingle();

      if (!masterDesa) {
        await sendMessage(chatId, `❌ TPS tidak ditemukan.`);
        return res.status(200).json({ ok: true });
      }

      const jumlahCalon = Math.min(Math.max(Number(masterDesa.jumlah_calon || 2), 1), MAX_CALON);
      await supabase.from('master_petugas').update({ tps_aktif: tpsSelected }).eq('chat_id_telegram', chatId);

      const example = Array(jumlahCalon).fill('0').concat(['0']).join('#');
      await removeKeyboard(
        chatId,
        `📌 <b>TPS TERPILIH: ${escapeHtml(tpsSelected)}</b>\n\nKirim angka dengan format:\n<code>${example}</code>`
      );
      return res.status(200).json({ ok: true });
    }

    // INPUT SUARA (MISAL: 100#80#5)
    if (text.includes('#')) {
      const tpsTarget = petugasLogin.tps_aktif;
      if (!tpsTarget) {
        await sendMessage(chatId, `⚠️ TPS belum dipilih. Ketik <code>/kirimhasil</code>.`);
        return res.status(200).json({ ok: true });
      }

      const { data: masterDesa } = await supabase
        .from('master_desa')
        .select('jumlah_calon')
        .eq('kecamatan', petugasLogin.kecamatan)
        .eq('desa', petugasLogin.desa)
        .eq('tps', tpsTarget)
        .maybeSingle();

      const jumlahCalon = Math.min(Math.max(Number(masterDesa?.jumlah_calon || 2), 1), MAX_CALON);
      const parsed = parseVoteInput(text, jumlahCalon);

      if (parsed.error) {
        await sendMessage(chatId, `❌ <b>INPUT TIDAK VALID</b>\n${escapeHtml(parsed.error)}`);
        return res.status(200).json({ ok: true });
      }

      const vote = parsed.result;
      await supabase.from('hasil_suara').upsert(
        {
          kecamatan: petugasLogin.kecamatan,
          desa: petugasLogin.desa,
          tps: tpsTarget,
          nrp_saksi: petugasLogin.nrp,
          nama_saksi: petugasLogin.nama_petugas,
          suara_calon_01: vote.calon_01,
          suara_calon_02: vote.calon_02,
          suara_calon_03: vote.calon_03,
          suara_calon_04: vote.calon_04,
          suara_calon_05: vote.calon_05,
          suara_tidak_sah: vote.tidak_sah,
          total_suara_masuk: vote.total,
          status_verifikasi: 'WAITING_C1',
          chat_id_saksi: chatId,
          input_format: text
        },
        { onConflict: 'kecamatan,desa,tps' }
      );

      await sendMessage(
        chatId,
        `📊 <b>ANGKA DITERIMA</b>\n\nSilakan kirimkan <b>foto C1 Plano</b> sekarang.`
      );
      return res.status(200).json({ ok: true });
    }

    // DEFAULT UNKNOWN COMMAND
    await sendMessage(
      chatId,
      `ℹ️ Perintah tidak dikenali.\n\n<code>/start</code> - Menu utama\n<code>/reg NRP</code> - Registrasi\n<code>/kirimhasil</code> - Laporkan suara`
    );

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('GLOBAL WEBHOOK ERROR:', error?.stack || error?.message || error);
    return res.status(200).json({ ok: true });
  }
}
