import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const BOT_TOKEN = process.env.BOT_TOKEN;

/**
 * Escape karakter HTML agar nama/data dari database
 * tidak merusak parse_mode HTML Telegram.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Kirim pesan ke Telegram menggunakan fetch.
 * Tidak lagi menggunakan https.request / Agent.
 */
async function sendMessage(chatId, text, replyMarkup = null) {
  if (!BOT_TOKEN) {
    console.error('ERROR: BOT_TOKEN tidak ditemukan di Environment Variables Vercel.');
    return null;
  }

  try {
    const body = {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML'
    };

    if (replyMarkup) {
      body.reply_markup = replyMarkup;
    }

    console.log('Mengirim pesan Telegram ke chat:', chatId);

    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );

    const result = await response.json();

    console.log(
      'Response Telegram:',
      JSON.stringify(result)
    );

    if (!response.ok || !result.ok) {
      console.error(
        'TELEGRAM SEND ERROR:',
        JSON.stringify(result)
      );

      return null;
    }

    return result;

  } catch (error) {
    console.error(
      'FETCH TELEGRAM ERROR:',
      error?.message || error
    );

    return null;
  }
}

/**
 * Menghapus keyboard Telegram.
 */
async function removeKeyboard(chatId, text) {
  return await sendMessage(chatId, text, {
    remove_keyboard: true
  });
}

/**
 * Handler utama Vercel.
 */
export default async function handler(req, res) {

  console.log('========================================');
  console.log('TELEGRAM WEBHOOK MASUK');
  console.log('METHOD:', req.method);
  console.log('========================================');

  // Telegram webhook menggunakan POST
  if (req.method !== 'POST') {
    return res.status(200).send('OK');
  }

  try {

    const update = req.body;

    console.log(
      'UPDATE TELEGRAM:',
      JSON.stringify(update)
    );

    // Pastikan update mempunyai message
    if (!update || !update.message) {
      console.log('Tidak ada update.message');
      return res.status(200).json({ ok: true });
    }

    const message = update.message;

    const chatId = String(message.chat?.id || '');

    const text = message.text
      ? String(message.text).trim()
      : '';

    console.log('CHAT ID:', chatId);
    console.log('TEXT:', text);

    if (!chatId) {
      console.error('Chat ID tidak ditemukan.');
      return res.status(200).json({ ok: true });
    }

    // =========================================================
    // 1. COMMAND /START
    // =========================================================

    const commandStart = text
      .toLowerCase()
      .split(/\s+/)[0];

    if (
      commandStart === '/start' ||
      commandStart === '/start@hitungcepatpilkades_bot'
    ) {

      console.log('COMMAND /START TERDETEKSI');

      const result = await sendMessage(
        chatId,

        `🇮🇩 <b>SELAMAT DATANG</b>\n\n` +

        `Bot Penghitungan Cepat Pilkades\n` +
        `Kabupaten Wonosobo Tahun 2026\n\n` +

        `Untuk melakukan registrasi petugas, ketik:\n\n` +

        `<code>/reg NRP</code>\n\n` +

        `<i>Contoh:</i>\n` +
        `<code>/reg 89080060</code>`
      );

      console.log(
        'HASIL SEND /START:',
        JSON.stringify(result)
      );

      return res.status(200).json({ ok: true });
    }

    // =========================================================
    // 2. COMMAND /BATAL
    // =========================================================

    if (
      commandStart === '/batal' ||
      commandStart === '/batal@hitungcepatpilkades_bot'
    ) {

      const { data: petugasBatal } = await supabase
        .from('master_petugas')
        .select('*')
        .eq('chat_id_telegram', `WAIT_${chatId}`)
        .maybeSingle();

      if (petugasBatal) {

        await supabase
          .from('master_petugas')
          .update({
            chat_id_telegram: null
          })
          .eq('nrp', petugasBatal.nrp);

      }

      await removeKeyboard(
        chatId,
        `✅ Proses dibatalkan.\n\n` +
        `Ketik <code>/start</code> untuk memulai kembali.`
      );

      return res.status(200).json({ ok: true });
    }

    // =========================================================
    // 3. COMMAND /REG NRP
    // =========================================================

    if (
      commandStart === '/reg' ||
      commandStart === '/reg@hitungcepatpilkades_bot'
    ) {

      console.log('COMMAND /REG TERDETEKSI');

      const parts = text.trim().split(/\s+/);

      const nrpInput = parts.length >= 2
        ? parts[1].trim()
        : '';

      if (!nrpInput) {

        await sendMessage(
          chatId,

          `⚠️ <b>FORMAT SALAH</b>\n\n` +

          `Gunakan format:\n` +
          `<code>/reg NRP</code>\n\n` +

          `Contoh:\n` +
          `<code>/reg 89080060</code>`
        );

        return res.status(200).json({ ok: true });
      }

      console.log('NRP INPUT:', nrpInput);

      const {
        data: petugas,
        error: errSearch
      } = await supabase
        .from('master_petugas')
        .select('*')
        .eq('nrp', nrpInput)
        .maybeSingle();

      if (errSearch) {

        console.error(
          'SUPABASE ERROR SEARCH PETUGAS:',
          errSearch
        );

        await sendMessage(
          chatId,

          `❌ <b>Terjadi kesalahan sistem.</b>\n\n` +
          `Database tidak dapat diakses.\n` +
          `Silakan coba beberapa saat lagi.`
        );

        return res.status(200).json({ ok: true });
      }

      if (!petugas) {

        await sendMessage(
          chatId,

          `❌ <b>NRP TIDAK TERDAFTAR</b>\n\n` +

          `NRP <code>${escapeHtml(nrpInput)}</code> ` +
          `tidak ditemukan dalam database.\n\n` +

          `Silakan hubungi Admin Panitia untuk ` +
          `pendaftaran petugas lapangan.`
        );

        return res.status(200).json({ ok: true });
      }

      // Simpan status WAIT
      const {
        error: errWait
      } = await supabase
        .from('master_petugas')
        .update({
          chat_id_telegram: `WAIT_${chatId}`
        })
        .eq('nrp', nrpInput);

      if (errWait) {

        console.error(
          'SUPABASE ERROR UPDATE WAIT:',
          errWait
        );

        await sendMessage(
          chatId,
          `❌ Gagal memulai proses registrasi.\n\n` +
          `Silakan coba kembali.`
        );

        return res.status(200).json({ ok: true });
      }

      await sendMessage(
        chatId,

        `✅ <b>NRP TERVERIFIKASI</b>\n\n` +

        `Halo <b>${escapeHtml(petugas.nama_petugas)}</b>.\n\n` +

        `NRP Anda berhasil ditemukan dalam database.\n\n` +

        `Silakan masukkan <b>PIN Rahasia</b> Anda.\n\n` +

        `Jika ingin membatalkan, ketik:\n` +
        `<code>/batal</code>`
      );

      return res.status(200).json({ ok: true });
    }

    // =========================================================
    // 4. CEK PETUGAS YANG SEDANG MENUNGGU PIN
    // =========================================================

    const {
      data: petugasWait,
      error: errWaitSearch
    } = await supabase
      .from('master_petugas')
      .select('*')
      .eq('chat_id_telegram', `WAIT_${chatId}`)
      .maybeSingle();

    if (errWaitSearch) {

      console.error(
        'SUPABASE ERROR WAIT:',
        errWaitSearch
      );

      await sendMessage(
        chatId,
        `❌ Terjadi kesalahan saat membaca data registrasi.`
      );

      return res.status(200).json({ ok: true });
    }

    if (petugasWait) {

      console.log(
        'PETUGAS WAIT DITEMUKAN:',
        petugasWait.nrp
      );

      // Cek PIN
      if (
        text !== '' &&
        text === String(petugasWait.pin ?? '').trim()
      ) {

        console.log('PIN BENAR');

        const {
          error: errLogin
        } = await supabase
          .from('master_petugas')
          .update({
            chat_id_telegram: chatId
          })
          .eq('nrp', petugasWait.nrp);

        if (errLogin) {

          console.error(
            'SUPABASE ERROR LOGIN:',
            errLogin
          );

          await sendMessage(
            chatId,
            `❌ PIN benar, tetapi gagal menyelesaikan registrasi.\n\n` +
            `Silakan coba kembali.`
          );

          return res.status(200).json({ ok: true });
        }

        await removeKeyboard(
          chatId,

          `🎉 <b>REGISTRASI BERHASIL</b>\n\n` +

          `Selamat datang,\n` +
          `<b>${escapeHtml(petugasWait.nama_petugas)}</b>\n\n` +

          `📍 Kecamatan : ` +
          `<b>${escapeHtml(petugasWait.kecamatan)}</b>\n` +

          `🏘 Desa : ` +
          `<b>${escapeHtml(petugasWait.desa)}</b>\n\n` +

          `Anda telah berhasil terdaftar sebagai petugas.\n\n` +

          `Untuk melaporkan hasil penghitungan suara, ketik:\n` +
          `<code>/kirimhasil</code>`
        );

        return res.status(200).json({ ok: true });

      } else {

        console.log('PIN SALAH');

        await sendMessage(
          chatId,

          `❌ <b>PIN SALAH</b>\n\n` +

          `PIN Rahasia yang Anda masukkan tidak sesuai.\n\n` +

          `Silakan masukkan PIN yang benar.\n\n` +

          `Jika ingin membatalkan:\n` +
          `<code>/batal</code>`
        );

        return res.status(200).json({ ok: true });
      }
    }

    // =========================================================
    // 5. CEK PETUGAS YANG SUDAH LOGIN
    // =========================================================

    const {
      data: petugasLogin,
      error: errLoginSearch
    } = await supabase
      .from('master_petugas')
      .select('*')
      .eq('chat_id_telegram', chatId)
      .maybeSingle();

    if (errLoginSearch) {

      console.error(
        'SUPABASE ERROR CEK LOGIN:',
        errLoginSearch
      );

      await sendMessage(
        chatId,
        `❌ Terjadi kesalahan saat memeriksa akun Anda.`
      );

      return res.status(200).json({ ok: true });
    }

    // =========================================================
    // 6. JIKA BELUM TERDAFTAR
    // =========================================================

    if (!petugasLogin) {

      await sendMessage(
        chatId,

        `🔐 <b>ANDA BELUM TERDAFTAR</b>\n\n` +

        `Silakan lakukan registrasi terlebih dahulu.\n\n` +

        `Ketik:\n` +
        `<code>/reg NRP</code>\n\n` +

        `Contoh:\n` +
        `<code>/reg 89080060</code>`
      );

      return res.status(200).json({ ok: true });
    }

    // =========================================================
    // 7. COMMAND /STATUS
    // =========================================================

    if (
      commandStart === '/status' ||
      commandStart === '/status@hitungcepatpilkades_bot'
    ) {

      await sendMessage(
        chatId,

        `👤 <b>STATUS PETUGAS</b>\n\n` +

        `Nama : <b>${escapeHtml(petugasLogin.nama_petugas)}</b>\n` +
        `NRP : <code>${escapeHtml(petugasLogin.nrp)}</code>\n` +
        `Kecamatan : <b>${escapeHtml(petugasLogin.kecamatan)}</b>\n` +
        `Desa : <b>${escapeHtml(petugasLogin.desa)}</b>\n` +
        `TPS Aktif : <b>${escapeHtml(petugasLogin.tps_aktif || '-')}</b>\n\n` +

        `Status : ✅ <b>TERDAFTAR</b>`
      );

      return res.status(200).json({ ok: true });
    }

    // =========================================================
    // 8. COMMAND /KIRIMHASIL
    // =========================================================

    if (
      commandStart === '/kirimhasil' ||
      commandStart === '/kirimhasil@hitungcepatpilkades_bot'
    ) {

      console.log(
        'COMMAND /KIRIMHASIL:',
        petugasLogin.nrp
      );

      const {
        data: daftarTps,
        error: errTps
      } = await supabase
        .from('master_desa')
        .select('tps')
        .eq('kecamatan', petugasLogin.kecamatan)
        .eq('desa', petugasLogin.desa);

      if (errTps) {

        console.error(
          'SUPABASE ERROR DAFTAR TPS:',
          errTps
        );
      }

      let keyboard = [];

      if (daftarTps && daftarTps.length > 0) {

        keyboard = daftarTps
          .filter(item => item.tps)
          .map(item => [
            {
              text: `📍 ${item.tps}`
            }
          ]);

      } else {

        // Fallback jika master_desa belum memiliki TPS
        keyboard = [
          [{ text: '📍 TPS 01' }],
          [{ text: '📍 TPS 02' }]
        ];
      }

      await sendMessage(
        chatId,

        `📋 <b>PANDUAN PELAPORAN HASIL SUARA</b>\n\n` +

        `Langkah 1:\n` +
        `Silakan pilih <b>TPS</b> tempat Anda bertugas ` +
        `di bawah ini.\n\n` +

        `Petugas:\n` +
        `<b>${escapeHtml(petugasLogin.nama_petugas)}</b>\n` +

        `Desa:\n` +
        `<b>${escapeHtml(petugasLogin.desa)}</b>`,

        {
          keyboard: keyboard,
          resize_keyboard: true,
          one_time_keyboard: true
        }
      );

      return res.status(200).json({ ok: true });
    }

    // =========================================================
    // 9. PILIHAN TPS
    // =========================================================

    if (
      text.startsWith('📍') ||
      /^tps\s*\d+/i.test(text)
    ) {

      const tpsSelected = text
        .replace('📍', '')
        .trim();

      if (!tpsSelected) {

        await sendMessage(
          chatId,
          `❌ TPS tidak valid. Silakan pilih TPS dari tombol yang tersedia.`
        );

        return res.status(200).json({ ok: true });
      }

      console.log(
        'TPS DIPILIH:',
        tpsSelected
      );

      const {
        error: errUpdateTps
      } = await supabase
        .from('master_petugas')
        .update({
          tps_aktif: tpsSelected
        })
        .eq('chat_id_telegram', chatId);

      if (errUpdateTps) {

        console.error(
          'SUPABASE ERROR UPDATE TPS:',
          errUpdateTps
        );

        await sendMessage(
          chatId,
          `❌ Gagal menyimpan pilihan TPS.\n\n` +
          `Silakan coba kembali.`
        );

        return res.status(200).json({ ok: true });
      }

      await sendMessage(
        chatId,

        `📌 <b>TPS TERPILIH</b>\n\n` +

        `TPS : <b>${escapeHtml(tpsSelected)}</b>\n\n` +

        `Langkah 2:\n` +
        `Kirimkan angka perolehan suara dengan format tanda pagar (#):\n\n` +

        `<code>[Calon 01]#[Calon 02]#[Calon 03]#[Tidak Sah]</code>\n\n` +

        `<i>Contoh:</i>\n` +
        `<code>120#80#40#10</code>\n\n` +

        `Jika ada 4 calon:\n` +
        `<code>120#80#40#30#10</code>\n\n` +

        `Jika ada 5 calon:\n` +
        `<code>120#80#40#30#20#10</code>`
      );

      return res.status(200).json({ ok: true });
    }

    // =========================================================
    // 10. INPUT SUARA DENGAN #
    // =========================================================

    if (text.includes('#')) {

      console.log(
        'INPUT SUARA:',
        text
      );

      const parts = text
        .split('#')
        .map(value => value.trim());

      // Minimal:
      // 1 calon + tidak sah
      if (parts.length < 2) {

        await sendMessage(
          chatId,

          `❌ <b>FORMAT SUARA SALAH</b>\n\n` +

          `Gunakan format:\n` +
          `<code>120#80#40#10</code>\n\n` +

          `Angka terakhir adalah suara tidak sah.`
        );

        return res.status(200).json({ ok: true });
      }

      // Validasi angka
      const invalid = parts.some(
        value => value === '' || !/^\d+$/.test(value)
      );

      if (invalid) {

        await sendMessage(
          chatId,

          `❌ <b>INPUT TIDAK VALID</b>\n\n` +

          `Semua nilai harus berupa angka.\n\n` +

          `Contoh benar:\n` +
          `<code>120#80#40#10</code>`
        );

        return res.status(200).json({ ok: true });
      }

      const rawArray = parts.map(
        value => parseInt(value, 10)
      );

      // Elemen terakhir = suara tidak sah
      const suaraTidakSah = rawArray.pop() || 0;

      const c01 = rawArray[0] || 0;
      const c02 = rawArray[1] || 0;
      const c03 = rawArray[2] || 0;
      const c04 = rawArray[3] || 0;
      const c05 = rawArray[4] || 0;

      // Maksimal 5 calon
      if (rawArray.length > 5) {

        await sendMessage(
          chatId,

          `❌ <b>JUMLAH CALON TIDAK SESUAI</b>\n\n` +

          `Sistem mendukung maksimal 5 calon.\n\n` +

          `Format maksimal:\n` +
          `<code>100#90#80#70#60#10</code>`
        );

        return res.status(200).json({ ok: true });
      }

      const totalSuara =
        c01 +
        c02 +
        c03 +
        c04 +
        c05 +
        suaraTidakSah;

      const tpsTarget =
        petugasLogin.tps_aktif || '';

      if (!tpsTarget) {

        await sendMessage(
          chatId,

          `⚠️ <b>TPS BELUM DIPILIH</b>\n\n` +

          `Silakan ketik:\n` +
          `<code>/kirimhasil</code>\n\n` +

          `kemudian pilih TPS terlebih dahulu.`
        );

        return res.status(200).json({ ok: true });
      }

      console.log(
        'DATA SUARA:',
        JSON.stringify({
          kecamatan: petugasLogin.kecamatan,
          desa: petugasLogin.desa,
          tps: tpsTarget,
          nrp: petugasLogin.nrp,
          c01,
          c02,
          c03,
          c04,
          c05,
          suaraTidakSah,
          totalSuara
        })
      );

      // =======================================================
      // SIMPAN / UPDATE HASIL
      // =======================================================

      const {
        data: hasilData,
        error: errHasil
      } = await supabase
        .from('hasil_suara')
        .upsert(
          {
            kecamatan: petugasLogin.kecamatan,
            desa: petugasLogin.desa,
            tps: tpsTarget,

            nrp_saksi: petugasLogin.nrp,
            nama_saksi: petugasLogin.nama_petugas,

            suara_calon_01: c01,
            suara_calon_02: c02,
            suara_calon_03: c03,
            suara_calon_04: c04,
            suara_calon_05: c05,

            suara_tidak_sah: suaraTidakSah,

            total_suara_masuk: totalSuara,

            status_verifikasi: 'AUTO_VERIFIED',

            chat_id_saksi: chatId
          },
          {
            onConflict: 'kecamatan,desa,tps'
          }
        )
        .select();

      if (errHasil) {

        console.error(
          'SUPABASE ERROR HASIL SUARA:',
          errHasil
        );

        await sendMessage(
          chatId,

          `❌ <b>GAGAL MENYIMPAN HASIL</b>\n\n` +

          `Pesan sistem:\n` +
          `<code>${escapeHtml(errHasil.message)}</code>\n\n` +

          `Silakan hubungi Admin jika masalah terus terjadi.`
        );

        return res.status(200).json({ ok: true });
      }

      console.log(
        'HASIL SUARA BERHASIL DISIMPAN:',
        JSON.stringify(hasilData)
      );

      // =======================================================
      // KONFIRMASI KE PETUGAS
      // =======================================================

      let rincian = '';

      rincian += `• Calon 01: <b>${c01}</b>\n`;

      rincian += `• Calon 02: <b>${c02}</b>\n`;

      rincian += `• Calon 03: <b>${c03}</b>\n`;

      if (rawArray.length >= 4) {
        rincian += `• Calon 04: <b>${c04}</b>\n`;
      }

      if (rawArray.length >= 5) {
        rincian += `• Calon 05: <b>${c05}</b>\n`;
      }

      rincian += `• Tidak Sah: <b>${suaraTidakSah}</b>\n`;

      await sendMessage(
        chatId,

        `📊 <b>RINCIAN ANGKA TERCATAT</b>\n\n` +

        `📍 TPS : <b>${escapeHtml(tpsTarget)}</b>\n\n` +

        rincian +

        `-------------------------\n` +

        `• <b>Total Suara Masuk: ${totalSuara}</b>\n\n` +

        `✅ Data berhasil disimpan ke sistem.\n\n` +

        `Langkah 3:\n` +

        `Silakan ambil/upload <b>Foto Lembar C1 Plano</b> ` +
        `dari HP Anda.\n\n` +

        `📌 Untuk mengirim hasil TPS lain, ketik:\n` +
        `<code>/kirimhasil</code>`
      );

      return res.status(200).json({ ok: true });
    }

    // =========================================================
    // 11. PESAN DEFAULT
    // =========================================================

    await sendMessage(
      chatId,

      `ℹ️ <b>PERINTAH TIDAK DIKENALI</b>\n\n` +

      `Gunakan salah satu perintah berikut:\n\n` +

      `<code>/start</code> - Menu awal\n` +
      `<code>/reg NRP</code> - Registrasi petugas\n` +
      `<code>/kirimhasil</code> - Kirim hasil suara\n` +
      `<code>/status</code> - Cek status akun\n` +
      `<code>/batal</code> - Batalkan proses`
    );

    return res.status(200).json({ ok: true });

  } catch (error) {

    // =========================================================
    // ERROR GLOBAL
    // =========================================================

    console.error(
      '========================================'
    );

    console.error(
      'ERROR GLOBAL WEBHOOK:'
    );

    console.error(
      error?.stack || error?.message || error
    );

    console.error(
      '========================================'
    );

    // Tetap balas 200 ke Telegram supaya Telegram
    // tidak terus-menerus mengulang update yang sama.
    return res.status(200).json({
      ok: true
    });
  }
}
