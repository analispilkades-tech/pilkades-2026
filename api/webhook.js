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

// Batas minimum keyakinan parser.
// Ini bukan confidence OCR resmi dari Tesseract.
// Nilai ini digunakan sebagai pengaman tambahan.
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
    throw new Error('BOT_TOKEN belum tersedia.');
  }

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    console.error(
      `Telegram API ERROR ${method}:`,
      JSON.stringify(result)
    );

    throw new Error(
      result?.description ||
      `Telegram API ${method} gagal.`
    );
  }

  return result;
}

async function sendMessage(
  chatId,
  text,
  replyMarkup = null
) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML'
  };

  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  try {
    return await telegramApi('sendMessage', payload);
  } catch (error) {
    console.error(
      'SEND MESSAGE ERROR:',
      error?.message || error
    );

    return null;
  }
}

async function answerCallbackQuery(
  callbackQueryId,
  text = ''
) {
  try {
    return await telegramApi(
      'answerCallbackQuery',
      {
        callback_query_id: callbackQueryId,
        text,
        show_alert: false
      }
    );
  } catch (error) {
    console.error(
      'ANSWER CALLBACK ERROR:',
      error?.message || error
    );

    return null;
  }
}

async function editMessage(
  chatId,
  messageId,
  text,
  replyMarkup = null
) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML'
  };

  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  try {
    return await telegramApi(
      'editMessageText',
      payload
    );
  } catch (error) {
    console.error(
      'EDIT MESSAGE ERROR:',
      error?.message || error
    );

    return null;
  }
}

async function removeKeyboard(chatId, text) {
  return sendMessage(
    chatId,
    text,
    {
      remove_keyboard: true
    }
  );
}


/* =========================================================
   TELEGRAM PHOTO
========================================================= */

async function getTelegramFile(fileId) {

  const result = await telegramApi(
    'getFile',
    {
      file_id: fileId
    }
  );

  return result.result;
}

async function downloadTelegramFile(filePath) {

  const response = await fetch(
    `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`
  );

  if (!response.ok) {
    throw new Error(
      `Gagal mengambil file Telegram. HTTP ${response.status}`
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  return Buffer.from(arrayBuffer);
}


/* =========================================================
   TESSERACT.JS OCR — GRATIS / TANPA API KEY
========================================================= */

/*
  PENTING (Vercel / serverless):

  File .wasm milik tesseract.js-core TIDAK ikut ter-bundle
  oleh proses build Vercel (dikecualikan secara otomatis).
  Kalau kita biarkan default (ambil file lokal dari
  node_modules), maka OCR akan SELALU gagal di production
  dengan error semacam:

    ENOENT: tesseract-core-relaxedsimd.wasm

  Solusi: paksa Tesseract.js mengambil file core-nya dari
  CDN (jsDelivr) alih-alih dari node_modules lokal.
  Versi core diambil otomatis dari package.json
  tesseract.js-core yang terpasang, supaya selalu cocok
  dengan versi tesseract.js yang dipakai.

  cachePath diarahkan ke /tmp karena itu satu-satunya
  folder yang bisa ditulis oleh Vercel Functions saat
  runtime (selain /tmp, filesystem bersifat read-only).
*/

let cachedCoreVersion = null;

function getTesseractCoreVersion() {

  if (cachedCoreVersion) {
    return cachedCoreVersion;
  }

  try {
    cachedCoreVersion =
      require('tesseract.js-core/package.json').version;
  } catch (error) {

    console.error(
      'GAGAL MEMBACA VERSI tesseract.js-core:',
      error?.message || error
    );

    cachedCoreVersion = null;
  }

  return cachedCoreVersion;
}

async function runOCR(imageBuffer) {
  let worker = null;

  try {
    console.log('OCR TESSERACT: MEMULAI');

    const coreVersion =
      getTesseractCoreVersion();

    const workerOptions = {

      corePath:
        coreVersion
          ? `https://cdn.jsdelivr.net/npm/tesseract.js-core@${coreVersion}`
          : 'https://cdn.jsdelivr.net/npm/tesseract.js-core',

      cachePath: '/tmp'
    };

    console.log(
      'OCR CORE PATH:',
      workerOptions.corePath
    );

    worker = await createWorker(
      'eng',
      1,
      workerOptions
    );

    /*
      Karena hasil yang kita cari terutama angka,
      gunakan whitelist agar OCR tidak terlalu bebas.
    */
    await worker.setParameters({
      tessedit_char_whitelist:
        '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz:-/#.',
      preserve_interword_spaces: '1'
    });

    const result = await worker.recognize(
      imageBuffer
    );

    const text =
      result?.data?.text || '';

    /*
      Tesseract.js memberikan confidence
      pada hasil pengenalan.
    */
    const confidence =
      Number(
        result?.data?.confidence || 0
      );

    console.log(
      'OCR TESSERACT CONFIDENCE:',
      confidence
    );

    console.log(
      'OCR TESSERACT TEXT:',
      text
    );

    return {
      text,
      confidence,
      raw: result?.data || null
    };

  } finally {

    if (worker) {
      try {
        await worker.terminate();
      } catch (error) {
        console.error(
          'GAGAL TERMINATE OCR WORKER:',
          error?.message || error
        );
      }
    }
  }
}


/* =========================================================
   PARSER OCR KONSERVATIF
========================================================= */

/*
  Karena format C1 Plano belum final, kita TIDAK boleh
  menebak angka berdasarkan posisi.

  Parser sementara hanya menerima angka yang jelas
  mempunyai label CALON / CANDIDATE.

  Contoh yang dikenali:

  CALON 01 120
  CALON 02 75
  CALON 03 5

  atau:

  CALON 01 : 120
  CALON 02 : 75

  Tidak Sah dicoba dikenali dari label.

  Jika struktur tidak cukup jelas -> WAITING_ADMIN.
*/

function extractLabeledNumber(
  text,
  patterns
) {

  for (const pattern of patterns) {

    const match =
      text.match(pattern);

    if (match && match[1] !== undefined) {

      const number =
        parseInt(
          String(match[1]).replace(/[^\d]/g, ''),
          10
        );

      if (Number.isInteger(number)) {
        return number;
      }
    }
  }

  return null;
}

function parseOCRVotes(
  ocrText,
  jumlahCalon
) {

  const normalized =
    String(ocrText || '')
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

    const number =
      String(i).padStart(2, '0');

    const patterns = [

      new RegExp(
        `CALON\\s*${number}\\D{0,15}(\\d{1,5})`,
        'i'
      ),

      new RegExp(
        `CALON\\s*${i}\\D{0,15}(\\d{1,5})`,
        'i'
      ),

      new RegExp(
        `C\\s*${number}\\D{0,15}(\\d{1,5})`,
        'i'
      ),

      new RegExp(
        `C\\s*${i}\\D{0,15}(\\d{1,5})`,
        'i'
      )
    ];

    const value =
      extractLabeledNumber(
        normalized,
        patterns
      );

    result[`calon_${number}`] =
      value;
  }

  result.tidak_sah =
    extractLabeledNumber(
      normalized,
      [
        /SUARA\s+TIDAK\s+SAH\D{0,15}(\d{1,5})/i,
        /TIDAK\s+SAH\D{0,15}(\d{1,5})/i,
        /TIDAKSAH\D{0,15}(\d{1,5})/i
      ]
    );

  let found = 0;

  for (let i = 1; i <= jumlahCalon; i++) {
    const key =
      `calon_${String(i).padStart(2, '0')}`;

    if (
      result[key] !== null &&
      Number.isInteger(result[key])
    ) {
      found++;
    }
  }

  const allCandidatesFound =
    found === jumlahCalon;

  const tidakSahFound =
    result.tidak_sah !== null;

  /*
    Confidence sementara.

    Ini BUKAN confidence Google Vision.
    Ini confidence parser kita.
  */

  let confidence = 0;

  if (allCandidatesFound) {
    confidence += 70;
  }

  if (tidakSahFound) {
    confidence += 20;
  }

  if (
    normalized.includes('JUMLAH') ||
    normalized.includes('TOTAL')
  ) {
    confidence += 10;
  }

  return {
    ...result,
    confidence,
    complete:
      allCandidatesFound &&
      tidakSahFound
  };
}


/* =========================================================
   PEMBANDINGAN
========================================================= */

function compareVotes(
  input,
  ocr,
  jumlahCalon
) {

  const differences = [];

  for (let i = 1; i <= jumlahCalon; i++) {

    const number =
      String(i).padStart(2, '0');

    const key =
      `calon_${number}`;

    const inputValue =
      Number(input[key] || 0);

    const ocrValue =
      Number(ocr[key] ?? -1);

    if (inputValue !== ocrValue) {

      differences.push({
        label: `Calon ${number}`,
        input: inputValue,
        ocr: ocrValue
      });
    }
  }

  const inputTidakSah =
    Number(input.tidak_sah || 0);

  const ocrTidakSah =
    Number(ocr.tidak_sah ?? -1);

  if (
    inputTidakSah !== ocrTidakSah
  ) {

    differences.push({
      label: 'Tidak Sah',
      input: inputTidakSah,
      ocr: ocrTidakSah
    });
  }

  return {
    matched:
      differences.length === 0,

    differences
  };
}


/* =========================================================
   INPUT SUARA
========================================================= */

function parseVoteInput(
  text,
  jumlahCalon
) {

  const parts =
    String(text)
      .split('#')
      .map(
        value => value.trim()
      );

  /*
    Jumlah elemen harus:
    jumlah calon + 1 tidak sah
  */

  const expected =
    jumlahCalon + 1;

  if (parts.length !== expected) {

    return {
      error:
        `Format membutuhkan ${expected} angka ` +
        `karena terdapat ${jumlahCalon} calon ` +
        `+ suara tidak sah.`
    };
  }

  const invalid =
    parts.some(
      value =>
        value === '' ||
        !/^\d+$/.test(value)
    );

  if (invalid) {

    return {
      error:
        'Semua nilai harus berupa angka positif.'
    };
  }

  const values =
    parts.map(
      value => parseInt(value, 10)
    );

  const result = {
    calon_01: 0,
    calon_02: 0,
    calon_03: 0,
    calon_04: 0,
    calon_05: 0,
    tidak_sah:
      values[values.length - 1]
  };

  for (let i = 0; i < jumlahCalon; i++) {

    const key =
      `calon_${String(i + 1).padStart(2, '0')}`;

    result[key] =
      values[i];
  }

  result.total =
    values.reduce(
      (sum, value) => sum + value,
      0
    );

  return {
    error: null,
    result
  };
}


/* =========================================================
   FORMAT DATA
========================================================= */

function buildVoteInputFromRow(row) {

  return {
    calon_01:
      Number(row.suara_calon_01 || 0),

    calon_02:
      Number(row.suara_calon_02 || 0),

    calon_03:
      Number(row.suara_calon_03 || 0),

    calon_04:
      Number(row.suara_calon_04 || 0),

    calon_05:
      Number(row.suara_calon_05 || 0),

    tidak_sah:
      Number(row.suara_tidak_sah || 0)
  };
}


/* =========================================================
   CARI DATA PENDING BERDASARKAN CHAT
========================================================= */

async function findPendingReport(
  chatId
) {

  const { data, error } =
    await supabase
      .from('hasil_suara')
      .select('*')
      .eq('chat_id_saksi', chatId)
      .in(
        'status_verifikasi',
        [
          'WAITING_C1',
          'OCR_PROCESSING',
          'WAITING_USER_CONFIRMATION',
          'WAITING_ADMIN'
        ]
      )
      .order(
        'timestamp',
        {
          ascending: false
        }
      )
      .limit(1)
      .maybeSingle();

  if (error) {

    console.error(
      'ERROR FIND PENDING:',
      error
    );

    return null;
  }

  return data;
}


/* =========================================================
   TAMPILKAN RINCIAN
========================================================= */

function buildVoteSummary(
  row,
  jumlahCalon
) {

  let text = '';

  for (let i = 1; i <= jumlahCalon; i++) {

    const key =
      `suara_calon_${String(i).padStart(2, '0')}`;

    text +=
      `• Calon ${String(i).padStart(2, '0')}: ` +
      `<b>${Number(row[key] || 0)}</b>\n`;
  }

  text +=
    `• Tidak Sah: ` +
    `<b>${Number(row.suara_tidak_sah || 0)}</b>\n`;

  text +=
    `-------------------------\n` +
    `• <b>Total Suara Masuk: ` +
    `${Number(row.total_suara_masuk || 0)}</b>`;

  return text;
}


/* =========================================================
   HANDLER FOTO C1
========================================================= */

async function handlePhoto(
  message,
  petugasLogin
) {

  const chatId =
    String(message.chat.id);

  console.log(
    'FOTO TELEGRAM DITERIMA:',
    chatId
  );

  const pending =
    await findPendingReport(chatId);

  if (!pending) {

    await sendMessage(
      chatId,

      `⚠️ <b>BELUM ADA DATA SUARA</b>\n\n` +

      `Silakan kirim angka hasil suara terlebih dahulu.\n\n` +

      `Contoh:\n` +
      `<code>120#75#5</code>\n\n` +

      `Setelah itu baru kirim foto C1 Plano.`
    );

    return;
  }

  /*
    Telegram mengirim beberapa ukuran foto.
    Kita pilih foto dengan ukuran terbesar.
  */

  const photos =
    Array.isArray(message.photo)
      ? message.photo
      : [];

  if (photos.length === 0) {

    await sendMessage(
      chatId,
      `❌ Foto tidak dapat dibaca oleh sistem.`
    );

    return;
  }

  const largestPhoto =
    photos[photos.length - 1];

  const fileId =
    largestPhoto.file_id;

  const fileUniqueId =
    largestPhoto.file_unique_id;

  /*
    Tandai OCR sedang diproses.
  */

  await supabase
    .from('hasil_suara')
    .update({
      status_verifikasi: 'OCR_PROCESSING',
      telegram_photo_file_id: fileId,
      telegram_photo_file_unique_id:
        fileUniqueId,
      ocr_processed_at: null
    })
    .eq('id', pending.id);

  await sendMessage(
    chatId,

    `📷 <b>FOTO C1 DITERIMA</b>\n\n` +
    `Foto sedang diperiksa oleh sistem.\n` +
    `Mohon tunggu...`
  );

  try {

    /*
      Ambil file dari Telegram.
    */

    const telegramFile =
      await getTelegramFile(fileId);

    if (!telegramFile?.file_path) {
      throw new Error(
        'Telegram tidak memberikan file_path.'
      );
    }

    const imageBuffer =
      await downloadTelegramFile(
        telegramFile.file_path
      );

    console.log(
      'UKURAN FOTO:',
      imageBuffer.length
    );

    /*
      OCR.
    */

    const ocr =
      await runOCR(imageBuffer);

    const ocrText =
      ocr.text || '';

    /*
      Ambil jumlah calon dari master_desa.
    */

    const { data: masterDesa } =
      await supabase
        .from('master_desa')
        .select('jumlah_calon')
        .eq(
          'kecamatan',
          pending.kecamatan
        )
        .eq(
          'desa',
          pending.desa
        )
        .eq(
          'tps',
          pending.tps
        )
        .maybeSingle();

    const jumlahCalon =
      Math.min(
        Math.max(
          Number(
            masterDesa?.jumlah_calon || 2
          ),
          1
        ),
        MAX_CALON
      );

    /*
      Parse OCR.
    */

    const parsed =
      parseOCRVotes(
        ocrText,
        jumlahCalon
      );

    console.log(
      'OCR PARSED:',
      JSON.stringify(parsed)
    );

    /*
      Simpan hasil OCR terlebih dahulu.
    */

    const ocrUpdate = {

      ocr_text:
        ocrText,

      ocr_calon_01:
        parsed.calon_01,

      ocr_calon_02:
        parsed.calon_02,

      ocr_calon_03:
        parsed.calon_03,

      ocr_calon_04:
        parsed.calon_04,

      ocr_calon_05:
        parsed.calon_05,

      ocr_tidak_sah:
        parsed.tidak_sah,

      ocr_total_suara:
        [
          parsed.calon_01,
          parsed.calon_02,
          parsed.calon_03,
          parsed.calon_04,
          parsed.calon_05,
          parsed.tidak_sah
        ]
          .filter(
            value =>
              Number.isInteger(value)
          )
          .reduce(
            (sum, value) =>
              sum + value,
            0
          ),

      ocr_confidence:
        parsed.confidence,

      ocr_engine:
        'TESSERACT.JS',

      ocr_status:
        parsed.complete
          ? 'COMPLETE'
          : 'INCOMPLETE',

      ocr_processed_at:
        new Date().toISOString()
    };

    /*
      OCR belum cukup jelas.
    */

    if (!parsed.complete) {

      await supabase
        .from('hasil_suara')
        .update({
          ...ocrUpdate,
          status_verifikasi:
            'WAITING_ADMIN'
        })
        .eq(
          'id',
          pending.id
        );

      await sendMessage(
        chatId,

        `⚠️ <b>OCR MEMERLUKAN VERIFIKASI ADMIN</b>\n\n` +

        `Foto C1 berhasil diterima, tetapi sistem ` +
        `belum dapat membaca seluruh angka dengan tingkat ` +
        `keyakinan yang cukup.\n\n` +

        `Data tidak ditampilkan sebagai hasil livecount ` +
        `sampai Admin melakukan verifikasi.\n\n` +

        `📍 TPS: <b>${escapeHtml(pending.tps)}</b>`
      );

      return;
    }

    /*
      Bandingkan dengan input petugas.
    */

    const input =
      buildVoteInputFromRow(
        pending
      );

    const comparison =
      compareVotes(
        input,
        parsed,
        jumlahCalon
      );


    /*
      ==========================================================
      OCR COCOK DENGAN INPUT PETUGAS
      TETAPI TETAP MEMINTA KONFIRMASI USER
      ==========================================================
    */

    if (
      comparison.matched &&
      parsed.confidence >= MIN_OCR_CONFIDENCE
    ) {

      await supabase
        .from('hasil_suara')
        .update({
          ...ocrUpdate,

          status_verifikasi:
            'WAITING_USER_CONFIRMATION',

          user_confirmation:
            'PENDING_MATCH_CONFIRMATION',

          catatan_verifikasi:
            'OCR cocok dengan input petugas. Menunggu konfirmasi petugas.'
        })
        .eq(
          'id',
          pending.id
        );

      const keyboard = {
        inline_keyboard: [

          [
            {
              text:
                '✅ YA, HASIL FOTO BENAR',
              callback_data:
                `OCR_MATCH_CONFIRM_${pending.id}`
            }
          ],

          [
            {
              text:
                '🔄 PERIKSA ULANG FOTO',
              callback_data:
                `OCR_MATCH_RECHECK_${pending.id}`
            }
          ],

          [
            {
              text:
                '👨‍💼 KIRIM KE ADMIN',
              callback_data:
                `OCR_MATCH_ADMIN_${pending.id}`
            }
          ]

        ]
      };

      await sendMessage(
        chatId,

        `✅ <b>HASIL FOTO SESUAI</b>\n\n` +

        `Sistem membaca angka pada foto C1 ` +
        `dan hasilnya <b>sama</b> dengan angka yang Anda kirim.\n\n` +

        `📍 TPS: <b>${escapeHtml(
          pending.tps
        )}</b>\n\n` +

        buildVoteSummary(
          pending,
          jumlahCalon
        ) +

        `\n\n` +

        `🔎 Confidence OCR: ` +
        `<b>${parsed.confidence.toFixed(1)}%</b>\n\n` +

        `Apakah Anda memastikan bahwa hasil tersebut benar?`,

        keyboard
      );

      return;
    }

    /*
      OCR berbeda.
    */

    await supabase
      .from('hasil_suara')
      .update({
        ...ocrUpdate,
        status_verifikasi:
          'WAITING_USER_CONFIRMATION'
      })
      .eq(
        'id',
        pending.id
      );

    let differenceText = '';

    for (
      const diff of comparison.differences
    ) {

      differenceText +=
        `• ${escapeHtml(diff.label)}: ` +
        `Input <b>${diff.input}</b> ` +
        `| C1 <b>${diff.ocr}</b>\n`;
    }

    const keyboard = {
      inline_keyboard: [

        [
          {
            text:
              '✅ Gunakan Hasil C1',
            callback_data:
              `OCR_ACCEPT_${pending.id}`
          }
        ],

        [
          {
            text:
              '⚠️ Pertahankan Input → Admin',
            callback_data:
              `OCR_REJECT_${pending.id}`
          }
        ]

      ]
    };

    await sendMessage(
      chatId,

      `⚠️ <b>PERBEDAAN DITEMUKAN</b>\n\n` +

      `Sistem menemukan perbedaan antara angka ` +
      `yang Anda kirim dengan hasil pembacaan C1.\n\n` +

      `<b>PERBEDAAN:</b>\n` +
      differenceText +

      `\n<b>Input Anda</b>\n` +
      buildVoteSummary(
        pending,
        jumlahCalon
      ) +

      `\n\nSilakan tentukan tindakan:`,

      keyboard
    );

  } catch (error) {

    console.error(
      'ERROR OCR FOTO:',
      error?.stack ||
      error?.message ||
      error
    );

    await supabase
      .from('hasil_suara')
      .update({
        status_verifikasi:
          'WAITING_ADMIN',

        ocr_status:
          'ERROR',

        ocr_engine:
          'TESSERACT.JS',

        catatan_verifikasi:
          error?.message ||
          'OCR gagal diproses.'
      })
      .eq(
        'id',
        pending.id
      );

    await sendMessage(
      chatId,

      `⚠️ <b>PEMERIKSAAN OTOMATIS GAGAL</b>\n\n` +

      `Foto C1 berhasil diterima, tetapi sistem ` +
      `tidak dapat menyelesaikan pemeriksaan otomatis.\n\n` +

      `Data telah ditempatkan pada daftar ` +
      `<b>VERIFIKASI ADMIN</b>.\n\n` +

      `Data <b>belum</b> dihitung dalam livecount.`
    );
  }
}


/* =========================================================
   CALLBACK KONFIRMASI USER
========================================================= */

async function handleCallbackQuery(
  callbackQuery
) {

  const callbackId =
    callbackQuery.id;

  const data =
    callbackQuery.data || '';

  const message =
    callbackQuery.message;

  const chatId =
    String(
      message?.chat?.id || ''
    );

  const messageId =
    message?.message_id;

  await answerCallbackQuery(
    callbackId
  );

  if (!chatId) {
    return;
  }

  /*
    ==========================================================
    OCR MATCH — USER CONFIRM
    ==========================================================
  */

  if (
    data.startsWith('OCR_MATCH_CONFIRM_')
  ) {

    const id =
      data.replace(
        'OCR_MATCH_CONFIRM_',
        ''
      );

    const {
      data: hasil,
      error
    } = await supabase
      .from('hasil_suara')
      .select('*')
      .eq('id', id)
      .eq('chat_id_saksi', chatId)
      .maybeSingle();

    if (
      error ||
      !hasil
    ) {

      await sendMessage(
        chatId,
        `❌ Data verifikasi tidak ditemukan.`
      );

      return;
    }

    if (
      hasil.status_verifikasi !==
      'WAITING_USER_CONFIRMATION'
    ) {

      await sendMessage(
        chatId,
        `ℹ️ Data ini sudah diproses sebelumnya.`
      );

      return;
    }

    const { error: updateError } =
      await supabase
        .from('hasil_suara')
        .update({

          status_verifikasi:
            'AUTO_VERIFIED',

          user_confirmation:
            'CONFIRMED_BY_USER',

          user_confirmation_at:
            new Date().toISOString(),

          verified_by:
            'BOT_OCR_USER_CONFIRMATION',

          verified_at:
            new Date().toISOString(),

          catatan_verifikasi:
            'OCR cocok dan dikonfirmasi oleh petugas.'
        })
        .eq(
          'id',
          id
        );

    if (updateError) {

      await sendMessage(
        chatId,
        `❌ Gagal mengesahkan data: ${escapeHtml(
          updateError.message
        )}`
      );

      return;
    }

    if (messageId) {

      await editMessage(
        chatId,
        messageId,

        `🎉 <b>VERIFIKASI BERHASIL</b>\n\n` +

        `Hasil foto C1 telah Anda konfirmasi.\n\n` +

        `📍 TPS: <b>${escapeHtml(
          hasil.tps
        )}</b>\n\n` +

        `🟢 Status: <b>AUTO VERIFIED</b>\n\n` +

        `Data sekarang telah masuk ke <b>LIVE COUNT</b>.`
      );

    } else {

      await sendMessage(
        chatId,

        `🎉 <b>VERIFIKASI BERHASIL</b>\n\n` +
        `Data telah masuk ke <b>LIVE COUNT</b>.`
      );

    }

    return;
  }

  /*
    ==========================================================
    OCR MATCH — USER KIRIM KE ADMIN
    ==========================================================
  */

  if (
    data.startsWith('OCR_MATCH_ADMIN_')
  ) {

    const id =
      data.replace(
        'OCR_MATCH_ADMIN_',
        ''
      );

    const {
      data: hasil
    } = await supabase
      .from('hasil_suara')
      .select('*')
      .eq('id', id)
      .eq('chat_id_saksi', chatId)
      .maybeSingle();

    if (!hasil) {

      await sendMessage(
        chatId,
        `❌ Data tidak ditemukan.`
      );

      return;
    }

    await supabase
      .from('hasil_suara')
      .update({

        status_verifikasi:
          'WAITING_ADMIN',

        user_confirmation:
          'SENT_TO_ADMIN',

        user_confirmation_at:
          new Date().toISOString(),

        catatan_verifikasi:
          'Petugas meminta verifikasi Admin meskipun OCR cocok.'
      })
      .eq(
        'id',
        id
      );

    if (messageId) {

      await editMessage(
        chatId,
        messageId,

        `👨‍💼 <b>DITERUSKAN KE ADMIN</b>\n\n` +

        `Data belum dihitung dalam Live Count.\n` +
        `Silakan menunggu pemeriksaan Admin.`
      );

    } else {

      await sendMessage(
        chatId,

        `👨‍💼 Data diteruskan ke Admin.\n` +
        `Data belum dihitung dalam Live Count.`
      );

    }

    return;
  }

  /*
    ==========================================================
    OCR MATCH — RECHECK
    ==========================================================
  */

  if (
    data.startsWith('OCR_MATCH_RECHECK_')
  ) {

    const id =
      data.replace(
        'OCR_MATCH_RECHECK_',
        ''
      );

    const {
      data: hasil
    } = await supabase
      .from('hasil_suara')
      .select('*')
      .eq('id', id)
      .eq('chat_id_saksi', chatId)
      .maybeSingle();

    if (!hasil) {

      await sendMessage(
        chatId,
        `❌ Data tidak ditemukan.`
      );

      return;
    }

    await supabase
      .from('hasil_suara')
      .update({

        status_verifikasi:
          'WAITING_C1',

        user_confirmation:
          'RECHECK_PHOTO',

        catatan_verifikasi:
          'Petugas meminta foto C1 diperiksa ulang.'
      })
      .eq(
        'id',
        id
      );

    if (messageId) {

      await editMessage(
        chatId,
        messageId,

        `🔄 <b>SIAP DIPERIKSA ULANG</b>\n\n` +

        `Silakan kirim ulang foto C1 Plano yang lebih jelas.`
      );

    } else {

      await sendMessage(
        chatId,

        `🔄 Silakan kirim ulang foto C1 Plano yang lebih jelas.`
      );

    }

    return;
  }

  if (
    data.startsWith('OCR_ACCEPT_')
  ) {

    const id =
      data.replace(
        'OCR_ACCEPT_',
        ''
      );

    const {
      data: hasil,
      error
    } = await supabase
      .from('hasil_suara')
      .select('*')
      .eq('id', id)
      .eq('chat_id_saksi', chatId)
      .maybeSingle();

    if (
      error ||
      !hasil
    ) {

      await sendMessage(
        chatId,
        `❌ Data verifikasi tidak ditemukan.`
      );

      return;
    }

    if (
      hasil.status_verifikasi !==
      'WAITING_USER_CONFIRMATION'
    ) {

      await sendMessage(
        chatId,

        `ℹ️ Data ini sudah diproses sebelumnya.`
      );

      return;
    }

    /*
      Gunakan hasil OCR sebagai hasil resmi.
    */

    const jumlahCalonResult =
      await supabase
        .from('master_desa')
        .select('jumlah_calon')
        .eq(
          'kecamatan',
          hasil.kecamatan
        )
        .eq(
          'desa',
          hasil.desa
        )
        .eq(
          'tps',
          hasil.tps
        )
        .maybeSingle();

    const jumlahCalon =
      Math.min(
        Math.max(
          Number(
            jumlahCalonResult
              ?.data
              ?.jumlah_calon || 2
          ),
          1
        ),
        MAX_CALON
      );

    const ocr01 =
      Number(
        hasil.ocr_calon_01 || 0
      );

    const ocr02 =
      Number(
        hasil.ocr_calon_02 || 0
      );

    const ocr03 =
      Number(
        hasil.ocr_calon_03 || 0
      );

    const ocr04 =
      Number(
        hasil.ocr_calon_04 || 0
      );

    const ocr05 =
      Number(
        hasil.ocr_calon_05 || 0
      );

    const ocrTidakSah =
      Number(
        hasil.ocr_tidak_sah || 0
      );

    const total =
      ocr01 +
      ocr02 +
      ocr03 +
      ocr04 +
      ocr05 +
      ocrTidakSah;

    const updateData = {

      suara_calon_01: ocr01,
      suara_calon_02: ocr02,
      suara_calon_03:
        jumlahCalon >= 3
          ? ocr03
          : 0,

      suara_calon_04:
        jumlahCalon >= 4
          ? ocr04
          : 0,

      suara_calon_05:
        jumlahCalon >= 5
          ? ocr05
          : 0,

      suara_tidak_sah:
        ocrTidakSah,

      total_suara_masuk:
        total,

      status_verifikasi:
        'AUTO_VERIFIED',

      verified_by:
        'USER_CONFIRMED_OCR',

      user_confirmation:
        'ACCEPT_OCR',

      verified_at:
        new Date().toISOString()
    };

    const {
      error: updateError
    } = await supabase
      .from('hasil_suara')
      .update(updateData)
      .eq('id', id);

    if (updateError) {

      console.error(
        'ERROR ACCEPT OCR:',
        updateError
      );

      await sendMessage(
        chatId,
        `❌ Gagal menyimpan hasil konfirmasi.`
      );

      return;
    }

    if (messageId) {

      await editMessage(
        chatId,
        messageId,

        `✅ <b>HASIL C1 DIKONFIRMASI</b>\n\n` +

        `Anda memilih menggunakan hasil pembacaan C1.\n\n` +

        `📍 TPS: <b>${escapeHtml(hasil.tps)}</b>\n\n` +

        `• Calon 01: <b>${ocr01}</b>\n` +
        `• Calon 02: <b>${ocr02}</b>\n` +

        (
          jumlahCalon >= 3
            ? `• Calon 03: <b>${ocr03}</b>\n`
            : ''
        ) +

        (
          jumlahCalon >= 4
            ? `• Calon 04: <b>${ocr04}</b>\n`
            : ''
        ) +

        (
          jumlahCalon >= 5
            ? `• Calon 05: <b>${ocr05}</b>\n`
            : ''
        ) +

        `• Tidak Sah: <b>${ocrTidakSah}</b>\n` +
        `-------------------------\n` +
        `• Total: <b>${total}</b>\n\n` +

        `🟢 <b>AUTO VERIFIED</b>\n` +
        `Data telah masuk livecount.`
      );

    } else {

      await sendMessage(
        chatId,
        `✅ Hasil C1 dikonfirmasi dan masuk livecount.`
      );
    }

    return;
  }


  /*
    USER MENOLAK HASIL OCR
  */

  if (
    data.startsWith('OCR_REJECT_')
  ) {

    const id =
      data.replace(
        'OCR_REJECT_',
        ''
      );

    const {
      data: hasil,
      error
    } = await supabase
      .from('hasil_suara')
      .select('*')
      .eq('id', id)
      .eq('chat_id_saksi', chatId)
      .maybeSingle();

    if (
      error ||
      !hasil
    ) {

      await sendMessage(
        chatId,
        `❌ Data verifikasi tidak ditemukan.`
      );

      return;
    }

    if (
      hasil.status_verifikasi !==
      'WAITING_USER_CONFIRMATION'
    ) {

      await sendMessage(
        chatId,
        `ℹ️ Data ini sudah diproses sebelumnya.`
      );

      return;
    }

    const {
      error: updateError
    } = await supabase
      .from('hasil_suara')
      .update({
        status_verifikasi:
          'WAITING_ADMIN',

        user_confirmation:
          'REJECT_OCR',

        catatan_verifikasi:
          'Petugas mempertahankan input awal. Menunggu verifikasi Admin.'
      })
      .eq('id', id);

    if (updateError) {

      console.error(
        'ERROR REJECT OCR:',
        updateError
      );

      await sendMessage(
        chatId,
        `❌ Gagal meneruskan data ke Admin.`
      );

      return;
    }

    if (messageId) {

      await editMessage(
        chatId,
        messageId,

        `⚠️ <b>DITERUSKAN KE ADMIN</b>\n\n` +

        `Anda memilih mempertahankan angka ` +
        `input awal.\n\n` +

        `Data sekarang menunggu pemeriksaan Admin ` +
        `dan <b>belum dihitung dalam livecount</b>.`
      );

    } else {

      await sendMessage(
        chatId,

        `⚠️ Data diteruskan ke Admin.\n` +
        `Data belum dihitung dalam livecount.`
      );
    }

    return;
  }
}


/* =========================================================
   HANDLER UTAMA
========================================================= */

export default async function handler(
  req,
  res
) {

  console.log(
    '========================================'
  );

  console.log(
    'TELEGRAM WEBHOOK'
  );

  console.log(
    'METHOD:',
    req.method
  );

  console.log(
    '========================================'
  );

  if (
    req.method !== 'POST'
  ) {

    return res
      .status(200)
      .send('OK');
  }

  try {

    const update =
      req.body;

    console.log(
      'UPDATE TYPE:',
      Object.keys(update || {})
    );

    /*
      ======================================================
      CALLBACK QUERY
      ======================================================
    */

    if (
      update?.callback_query
    ) {

      await handleCallbackQuery(
        update.callback_query
      );

      return res
        .status(200)
        .json({
          ok: true
        });
    }


    /*
      ======================================================
      MESSAGE
      ======================================================
    */

    if (
      !update?.message
    ) {

      return res
        .status(200)
        .json({
          ok: true
        });
    }

    const message =
      update.message;

    const chatId =
      String(
        message.chat?.id || ''
      );

    const text =
      message.text
        ? String(
            message.text
          ).trim()
        : '';

    if (!chatId) {

      return res
        .status(200)
        .json({
          ok: true
        });
    }

    console.log(
      'CHAT ID:',
      chatId
    );

    console.log(
      'TEXT:',
      text
    );

    /*
      ======================================================
      FOTO HARUS DIPROSES SEBELUM DEFAULT RESPONSE
      ======================================================
    */

    if (
      Array.isArray(
        message.photo
      ) &&
      message.photo.length > 0
    ) {

      const {
        data: petugasFoto,
        error: errorPetugasFoto
      } = await supabase
        .from('master_petugas')
        .select('*')
        .eq(
          'chat_id_telegram',
          chatId
        )
        .maybeSingle();

      if (
        errorPetugasFoto ||
        !petugasFoto
      ) {

        await sendMessage(
          chatId,

          `🔐 <b>ANDA BELUM TERDAFTAR</b>\n\n` +
          `Silakan registrasi terlebih dahulu dengan:\n` +
          `<code>/reg NRP</code>`
        );

        return res
          .status(200)
          .json({
            ok: true
          });
      }

      await handlePhoto(
        message,
        petugasFoto
      );

      return res
        .status(200)
        .json({
          ok: true
        });
    }


    /*
      ======================================================
      COMMAND
      ======================================================
    */

    const command =
      commandOf(text);


    /*
      ======================================================
      /START
      ======================================================
    */

    if (
      command === '/start' ||
      command ===
        '/start@hitungcepatpilkades_bot'
    ) {

      await sendMessage(
        chatId,

        `🇮🇩 <b>SELAMAT DATANG</b>\n\n` +

        `Bot Penghitungan Cepat Pilkades\n` +
        `Kabupaten Wonosobo Tahun 2026\n\n` +

        `Untuk melakukan registrasi petugas, ketik:\n\n` +

        `<code>/reg NRP</code>\n\n` +

        `<i>Contoh:</i>\n` +
        `<code>/reg 89080060</code>`
      );

      return res
        .status(200)
        .json({
          ok: true
        });
    }


    /*
      ======================================================
      /BATAL
      ======================================================
    */

    if (
      command === '/batal' ||
      command ===
        '/batal@hitungcepatpilkades_bot'
    ) {

      const {
        data: petugasBatal
      } = await supabase
        .from('master_petugas')
        .select('*')
        .eq(
          'chat_id_telegram',
          `WAIT_${chatId}`
        )
        .maybeSingle();

      if (petugasBatal) {

        await supabase
          .from('master_petugas')
          .update({
            chat_id_telegram:
              null
          })
          .eq(
            'nrp',
            petugasBatal.nrp
          );
      }

      await removeKeyboard(
        chatId,

        `✅ Proses dibatalkan.\n\n` +
        `Ketik <code>/start</code> untuk memulai kembali.`
      );

      return res
        .status(200)
        .json({
          ok: true
        });
    }


    /*
      ======================================================
      /REG
      ======================================================
    */

    if (
      command === '/reg' ||
      command ===
        '/reg@hitungcepatpilkades_bot'
    ) {

      const parts =
        text
          .trim()
          .split(/\s+/);

      const nrpInput =
        parts.length >= 2
          ? parts[1].trim()
          : '';

      if (!nrpInput) {

        await sendMessage(
          chatId,

          `⚠️ <b>FORMAT SALAH</b>\n\n` +
          `Gunakan:\n` +
          `<code>/reg NRP</code>\n\n` +
          `Contoh:\n` +
          `<code>/reg 89080060</code>`
        );

        return res
          .status(200)
          .json({
            ok: true
          });
      }

      const {
        data: petugas,
        error
      } = await supabase
        .from('master_petugas')
        .select('*')
        .eq(
          'nrp',
          nrpInput
        )
        .maybeSingle();

      if (error) {

        console.error(
          'ERROR SEARCH PETUGAS:',
          error
        );

        await sendMessage(
          chatId,
          `❌ Database tidak dapat diakses.`
        );

        return res
          .status(200)
          .json({
            ok: true
          });
      }

      if (!petugas) {

        await sendMessage(
          chatId,

          `❌ <b>NRP TIDAK TERDAFTAR</b>\n\n` +
          `NRP <code>${escapeHtml(nrpInput)}</code> ` +
          `tidak ditemukan.\n\n` +
          `Silakan hubungi Admin Panitia.`
        );

        return res
          .status(200)
          .json({
            ok: true
          });
      }

      await supabase
        .from('master_petugas')
        .update({
          chat_id_telegram:
            `WAIT_${chatId}`
        })
        .eq(
          'nrp',
          nrpInput
        );

      await sendMessage(
        chatId,

        `✅ <b>NRP TERVERIFIKASI</b>\n\n` +

        `Halo <b>${escapeHtml(
          petugas.nama_petugas
        )}</b>.\n\n` +

        `NRP Anda berhasil ditemukan dalam database.\n\n` +

        `Silakan masukkan <b>PIN Rahasia</b> Anda.\n\n` +

        `Jika ingin membatalkan:\n` +
        `<code>/batal</code>`
      );

      return res
        .status(200)
        .json({
          ok: true
        });
    }


    /*
      ======================================================
      CEK PIN
      ======================================================
    */

    const {
      data: petugasWait
    } = await supabase
      .from('master_petugas')
      .select('*')
      .eq(
        'chat_id_telegram',
        `WAIT_${chatId}`
      )
      .maybeSingle();

    if (petugasWait) {

      if (
        text !== '' &&
        text ===
          String(
            petugasWait.pin ?? ''
          ).trim()
      ) {

        await supabase
          .from('master_petugas')
          .update({
            chat_id_telegram:
              chatId
          })
          .eq(
            'nrp',
            petugasWait.nrp
          );

        await removeKeyboard(
          chatId,

          `🎉 <b>REGISTRASI BERHASIL</b>\n\n` +

          `Selamat datang,\n` +
          `<b>${escapeHtml(
            petugasWait.nama_petugas
          )}</b>\n\n` +

          `📍 Kecamatan : <b>${escapeHtml(
            petugasWait.kecamatan
          )}</b>\n` +

          `🏘 Desa : <b>${escapeHtml(
            petugasWait.desa
          )}</b>\n\n` +

          `Untuk melaporkan hasil penghitungan suara:\n` +
          `<code>/kirimhasil</code>`
        );

      } else {

        await sendMessage(
          chatId,

          `❌ <b>PIN SALAH</b>\n\n` +
          `Silakan masukkan PIN Rahasia yang benar.\n\n` +
          `Jika ingin membatalkan:\n` +
          `<code>/batal</code>`
        );
      }

      return res
        .status(200)
        .json({
          ok: true
        });
    }


    /*
      ======================================================
      CEK LOGIN
      ======================================================
    */

    const {
      data: petugasLogin,
      error: loginError
    } = await supabase
      .from('master_petugas')
      .select('*')
      .eq(
        'chat_id_telegram',
        chatId
      )
      .maybeSingle();

    if (loginError) {

      console.error(
        'ERROR CEK LOGIN:',
        loginError
      );

      await sendMessage(
        chatId,
        `❌ Terjadi kesalahan saat membaca akun Anda.`
      );

      return res
        .status(200)
        .json({
          ok: true
        });
    }

    if (!petugasLogin) {

      await sendMessage(
        chatId,

        `🔐 <b>ANDA BELUM TERDAFTAR</b>\n\n` +
        `Ketik:\n` +
        `<code>/reg NRP</code>`
      );

      return res
        .status(200)
        .json({
          ok: true
        });
    }


    /*
      ======================================================
      /STATUS
      ======================================================
    */

    if (
      command === '/status' ||
      command ===
        '/status@hitungcepatpilkades_bot'
    ) {

      await sendMessage(
        chatId,

        `👤 <b>STATUS PETUGAS</b>\n\n` +

        `Nama : <b>${escapeHtml(
          petugasLogin.nama_petugas
        )}</b>\n` +

        `NRP : <code>${escapeHtml(
          petugasLogin.nrp
        )}</code>\n` +

        `Kecamatan : <b>${escapeHtml(
          petugasLogin.kecamatan
        )}</b>\n` +

        `Desa : <b>${escapeHtml(
          petugasLogin.desa
        )}</b>\n` +

        `TPS Aktif : <b>${escapeHtml(
          petugasLogin.tps_aktif || '-'
        )}</b>\n\n` +

        `Status : ✅ <b>TERDAFTAR</b>`
      );

      return res
        .status(200)
        .json({
          ok: true
        });
    }


    /*
      ======================================================
      /KIRIMHASIL
      ======================================================
    */

    if (
      command === '/kirimhasil' ||
      command ===
        '/kirimhasil@hitungcepatpilkades_bot'
    ) {

      const {
        data: daftarTps
      } = await supabase
        .from('master_desa')
        .select('tps')
        .eq(
          'kecamatan',
          petugasLogin.kecamatan
        )
        .eq(
          'desa',
          petugasLogin.desa
        )
        .order('tps');

      const keyboard =
        daftarTps?.length
          ? daftarTps.map(
              item => [
                {
                  text:
                    `📍 ${item.tps}`
                }
              ]
            )
          : [
              [
                {
                  text:
                    '📍 TPS 01'
                }
              ],
              [
                {
                  text:
                    '📍 TPS 02'
                }
              ]
            ];

      await sendMessage(
        chatId,

        `📋 <b>PANDUAN PELAPORAN HASIL SUARA</b>\n\n` +

        `Langkah 1:\n` +
        `Silakan pilih <b>TPS</b>.\n\n` +

        `Petugas:\n` +
        `<b>${escapeHtml(
          petugasLogin.nama_petugas
        )}</b>\n\n` +

        `Desa:\n` +
        `<b>${escapeHtml(
          petugasLogin.desa
        )}</b>`,

        {
          keyboard,
          resize_keyboard: true,
          one_time_keyboard: true
        }
      );

      return res
        .status(200)
        .json({
          ok: true
        });
    }


    /*
      ======================================================
      PILIH TPS
      ======================================================
    */

    if (
      text.startsWith('📍') ||
      /^tps\s*\d+/i.test(text)
    ) {

      const tpsSelected =
        text
          .replace('📍', '')
          .trim();

      const {
        data: masterDesa
      } = await supabase
        .from('master_desa')
        .select(
          'tps,jumlah_calon'
        )
        .eq(
          'kecamatan',
          petugasLogin.kecamatan
        )
        .eq(
          'desa',
          petugasLogin.desa
        )
        .eq(
          'tps',
          tpsSelected
        )
        .maybeSingle();

      if (!masterDesa) {

        await sendMessage(
          chatId,

          `❌ <b>TPS TIDAK TERDAFTAR</b>\n\n` +
          `TPS <b>${escapeHtml(
            tpsSelected
          )}</b> tidak ditemukan dalam master TPS.`
        );

        return res
          .status(200)
          .json({
            ok: true
          });
      }

      const jumlahCalon =
        Math.min(
          Math.max(
            Number(
              masterDesa.jumlah_calon || 2
            ),
            1
          ),
          MAX_CALON
        );

      await supabase
        .from('master_petugas')
        .update({
          tps_aktif:
            tpsSelected
        })
        .eq(
          'chat_id_telegram',
          chatId
        );

      const formatParts =
        [];

      for (
        let i = 1;
        i <= jumlahCalon;
        i++
      ) {

        formatParts.push(
          `Calon ${String(i).padStart(2, '0')}`
        );
      }

      formatParts.push(
        'Tidak Sah'
      );

      const format =
        formatParts.join('#');

      const example =
        Array(jumlahCalon)
          .fill('0')
          .concat(['0'])
          .join('#');

      await removeKeyboard(
        chatId,

        `📌 <b>TPS TERPILIH</b>\n\n` +

        `TPS : <b>${escapeHtml(
          tpsSelected
        )}</b>\n` +

        `Jumlah Calon : <b>${jumlahCalon}</b>\n\n` +

        `Langkah 2:\n` +
        `Kirim angka dengan format:\n` +

        `<code>${escapeHtml(
          format
        )}</code>\n\n` +

        `Contoh:\n` +
        `<code>${example}</code>\n\n` +

        `Angka terakhir adalah <b>suara tidak sah</b>.\n\n` +

        `Setelah angka diterima, bot akan meminta ` +
        `Anda mengirim foto C1 Plano untuk pemeriksaan.`
      );

      return res
        .status(200)
        .json({
          ok: true
        });
    }


    /*
      ======================================================
      INPUT SUARA
      ======================================================
    */

    if (
      text.includes('#')
    ) {

      const tpsTarget =
        petugasLogin.tps_aktif;

      if (!tpsTarget) {

        await sendMessage(
          chatId,

          `⚠️ <b>TPS BELUM DIPILIH</b>\n\n` +
          `Ketik <code>/kirimhasil</code> terlebih dahulu.`
        );

        return res
          .status(200)
          .json({
            ok: true
          });
      }

      /*
        Ambil jumlah calon.
      */

      const {
        data: masterDesa
      } = await supabase
        .from('master_desa')
        .select(
          'jumlah_calon'
        )
        .eq(
          'kecamatan',
          petugasLogin.kecamatan
        )
        .eq(
          'desa',
          petugasLogin.desa
        )
        .eq(
          'tps',
          tpsTarget
        )
        .maybeSingle();

      const jumlahCalon =
        Math.min(
          Math.max(
            Number(
              masterDesa?.jumlah_calon || 2
            ),
            1
          ),
          MAX_CALON
        );

      const parsed =
        parseVoteInput(
          text,
          jumlahCalon
        );

      if (parsed.error) {

        await sendMessage(
          chatId,

          `❌ <b>INPUT TIDAK VALID</b>\n\n` +
          `${escapeHtml(
            parsed.error
          )}\n\n` +

          `Untuk <b>${jumlahCalon} calon</b>:\n` +

          `<code>${Array(
            jumlahCalon + 1
          ).fill('0').join('#')}</code>\n\n` +

          `Angka terakhir = <b>Tidak Sah</b>.`
        );

        return res
          .status(200)
          .json({
            ok: true
          });
      }

      const vote =
        parsed.result;

      /*
        Upsert sebagai WAITING_C1,
        BUKAN AUTO_VERIFIED.
      */

      const {
        data: hasilData,
        error: hasilError
      } = await supabase
        .from('hasil_suara')
        .upsert(
          {

            kecamatan:
              petugasLogin.kecamatan,

            desa:
              petugasLogin.desa,

            tps:
              tpsTarget,

            nrp_saksi:
              petugasLogin.nrp,

            nama_saksi:
              petugasLogin.nama_petugas,

            suara_calon_01:
              vote.calon_01,

            suara_calon_02:
              vote.calon_02,

            suara_calon_03:
              vote.calon_03,

            suara_calon_04:
              vote.calon_04,

            suara_calon_05:
              vote.calon_05,

            suara_tidak_sah:
              vote.tidak_sah,

            total_suara_masuk:
              vote.total,

            status_verifikasi:
              'WAITING_C1',

            chat_id_saksi:
              chatId,

            input_format:
              text,

            /*
              Bersihkan data OCR lama
              bila TPS dikirim ulang.
            */

            ocr_text:
              null,

            ocr_calon_01:
              null,

            ocr_calon_02:
              null,

            ocr_calon_03:
              null,

            ocr_calon_04:
              null,

            ocr_calon_05:
              null,

            ocr_tidak_sah:
              null,

            ocr_confidence:
              null,

            telegram_photo_file_id:
              null,

            telegram_photo_file_unique_id:
              null,

            user_confirmation:
              null,

            verified_by:
              null,

            verified_at:
              null,

            catatan_verifikasi:
              null
          },

          {
            onConflict:
              'kecamatan,desa,tps'
          }
        )
        .select()
        .single();

      if (hasilError) {

        console.error(
          'ERROR SIMPAN SUARA:',
          hasilError
        );

        await sendMessage(
          chatId,

          `❌ <b>GAGAL MENYIMPAN HASIL</b>\n\n` +
          `<code>${escapeHtml(
            hasilError.message
          )}</code>`
        );

        return res
          .status(200)
          .json({
            ok: true
          });
      }

      let rincian = '';

      for (
        let i = 1;
        i <= jumlahCalon;
        i++
      ) {

        const key =
          `calon_${String(i).padStart(2, '0')}`;

        rincian +=
          `• Calon ${String(i).padStart(2, '0')}: ` +
          `<b>${vote[key]}</b>\n`;
      }

      rincian +=
        `• Tidak Sah: <b>${vote.tidak_sah}</b>\n` +
        `-------------------------\n` +
        `• <b>Total Suara Masuk: ${vote.total}</b>`;

      await sendMessage(
        chatId,

        `📊 <b>ANGKA DITERIMA</b>\n\n` +

        `📍 TPS : <b>${escapeHtml(
          tpsTarget
        )}</b>\n\n` +

        rincian +

        `\n\n🟡 Status: <b>MENUNGGU FOTO C1</b>\n\n` +

        `Silakan kirim <b>foto C1 Plano</b> ` +
        `TPS ini sekarang.\n\n` +

        `Bot akan membandingkan foto C1 dengan ` +
        `angka yang Anda kirim sebelum data dinyatakan terverifikasi.`
      );

      return res
        .status(200)
        .json({
          ok: true
        });
    }


    /*
      ======================================================
      DEFAULT
      ======================================================
    */

    await sendMessage(
      chatId,

      `ℹ️ <b>PERINTAH TIDAK DIKENALI</b>\n\n` +

      `Gunakan:\n\n` +

      `<code>/start</code> - Menu awal\n` +
      `<code>/reg NRP</code> - Registrasi\n` +
      `<code>/kirimhasil</code> - Kirim hasil\n` +
      `<code>/status</code> - Status akun\n` +
      `<code>/batal</code> - Batalkan proses`
    );

    return res
      .status(200)
      .json({
        ok: true
      });

  } catch (error) {

    console.error(
      '========================================'
    );

    console.error(
      'GLOBAL WEBHOOK ERROR:'
    );

    console.error(
      error?.stack ||
      error?.message ||
      error
    );

    console.error(
      '========================================'
    );

    /*
      Tetap 200 agar Telegram tidak mengirim
      update yang sama berulang-ulang.
    */

    return res
      .status(200)
      .json({
        ok: true
      });
  }
}
