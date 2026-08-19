import https from 'https';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const BOT_TOKEN = process.env.BOT_TOKEN;

// Agent HTTPS untuk menjaga koneksi TLS di lingkungan Serverless Vercel
const agent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: true
});

// Fungsi sendMessage menggunakan modul HTTPS native Node.js (Solusi TypeError: fetch failed)
function sendMessage(chatId, text, replyMarkup = null) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    });

    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      agent: agent,
      timeout: 8000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { resolve(data); });
    });

    req.on('error', (e) => {
      console.error('Error SendMessage (HTTPS):', e.message);
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.write(payload);
    req.end();
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  // Berikan respon HTTP 200 OK secara cepat ke Telegram
  res.status(200).json({ ok: true });

  const update = req.body;
  if (!update || !update.message) return;

  const chatId = String(update.message.chat.id);
  const text = update.message.text ? update.message.text.trim() : '';

  try {
    // ===================================================
    // 1. COMMAND /start (Sama sekali tidak menggunakan Supabase)
    // ===================================================
    if (text === '/start') {
      await sendMessage(
        chatId,
        `Selamat datang di bot penghitungan cepat Pilkades Kab. Wonosobo 2026 🇮🇩\n\n` +
        `Ketik <code>/reg&lt;spasi&gt;NRP</code> untuk registrasi\n` +
        `<i>(Contoh: <code>/reg 89080060</code>)</i>`
      );
      return;
    }

    // ===================================================
    // 2. COMMAND /reg <NRP>
    // ===================================================
    if (text.toLowerCase().startsWith('/reg')) {
      const parts = text.split(' ');
      const nrpInput = parts.length > 1 ? parts[1].trim() : '';

      if (!nrpInput) {
        await sendMessage(
          chatId,
          `⚠️ Format salah. Ketik <code>/reg&lt;spasi&gt;NRP</code>\n<i>Contoh: <code>/reg 89080060</code></i>`
        );
        return;
      }

      // Cek NRP di database
      const { data: petugas, error: errSearch } = await supabase
        .from('master_petugas')
        .select('*')
        .eq('nrp', nrpInput)
        .maybeSingle();

      if (errSearch || !petugas) {
        await sendMessage(
          chatId,
          `❌ <b>NRP tidak terdaftar!</b>\n\nSilakan hubungi Admin Panitia untuk pendaftaran petugas lapangan.`
        );
        return;
      }

      // Simpan chat_id_telegram secara langsung sebagai status menunggu PIN
      await supabase
        .from('master_petugas')
        .update({ chat_id_telegram: `WAIT_${chatId}` })
        .eq('nrp', nrpInput);

      await sendMessage(
        chatId,
        `Halo <b>${petugas.nama_petugas}</b>, NRP Anda terverifikasi.\n\n` +
        `Silakan masukkan <b>PIN Rahasia</b> Anda:`
      );
      return;
    }

    // ===================================================
    // 3. PROSES VERIFIKASI PIN
    // ===================================================
    // Cek apakah ada petugas dengan status WAIT_chatId
    const { data: petugasWait } = await supabase
      .from('master_petugas')
      .select('*')
      .eq('chat_id_telegram', `WAIT_${chatId}`)
      .maybeSingle();

    if (petugasWait) {
      if (text === String(petugasWait.pin).trim()) {
        // PIN Benar: Aktifkan Chat ID resmi
        await supabase
          .from('master_petugas')
          .update({ chat_id_telegram: chatId })
          .eq('nrp', petugasWait.nrp);

        await sendMessage(
          chatId,
          `Selamat datang <b>${petugasWait.nama_petugas}</b>, Anda teregister pada:\n` +
          `• Kecamatan : <b>${petugasWait.kecamatan}</b>\n` +
          `• Desa : <b>${petugasWait.desa}</b>\n\n` +
          `Ketik <b>/kirimhasil</b> untuk melaporkan hasil, dan ikuti panduannya.`
        );
        return;
      } else {
        await sendMessage(
          chatId,
          `❌ <b>PIN Salah!</b> Silakan masukkan PIN Rahasia Anda dengan benar:`
        );
        return;
      }
    }

    // Ambil akun petugas yang sudah aktif
    const { data: petugasLogin } = await supabase
      .from('master_petugas')
      .select('*')
      .eq('chat_id_telegram', chatId)
      .maybeSingle();

    if (!petugasLogin) {
      await sendMessage(
        chatId,
        `Ketik <code>/reg&lt;spasi&gt;NRP</code> untuk melakukan registrasi.`
      );
      return;
    }

    // ===================================================
    // 4. COMMAND /kirimhasil
    // ===================================================
    if (text === '/kirimhasil') {
      const { data: daftarTps } = await supabase
        .from('master_desa')
        .select('tps')
        .eq('kecamatan', petugasLogin.kecamatan)
        .eq('desa', petugasLogin.desa);

      let keyboard = [];
      if (daftarTps && daftarTps.length > 0) {
        keyboard = daftarTps.map(t => [{ text: `📍 ${t.tps}` }]);
      } else {
        keyboard = [[{ text: '📍 TPS 01' }], [{ text: '📍 TPS 02' }]];
      }

      await sendMessage(
        chatId,
        `📋 <b>PANDUAN PELAPORAN HASIL SUARA</b>\n\n` +
        `Langkah 1: Silakan pilih <b>TPS</b> tempat Anda bertugas di bawah ini:`,
        {
          keyboard: keyboard,
          resize_keyboard: true,
          one_time_keyboard: true
        }
      );
      return;
    }

    // ===================================================
    // 5. INPUT PILIHAN TPS
    // ===================================================
    if (text.startsWith('📍') || text.toLowerCase().startsWith('tps')) {
      const tpsSelected = text.replace('📍', '').trim();

      await supabase
        .from('master_petugas')
        .update({ tps_aktif: tpsSelected })
        .eq('chat_id_telegram', chatId);

      await sendMessage(
        chatId,
        `📌 TPS Terpilih: <b>${tpsSelected}</b>\n\n` +
        `Langkah 2: Kirimkan angka perolehan suara dengan format tanda pagar (#):\n` +
        `<code>[Calon 01]#[Calon 02]#[Calon 03]#[Tidak Sah]</code>\n\n` +
        `<i>Contoh: 120#80#40#10</i>`
      );
      return;
    }

    // ===================================================
    // 6. INPUT ANGKA SUARA (#)
    // ===================================================
    if (text.includes('#')) {
      const rawArray = text.split('#').map(a => parseInt(a.trim()) || 0);
      const tpsTarget = petugasLogin.tps_aktif || 'TPS 01';

      const suaraTidakSah = rawArray.length > 1 ? rawArray.pop() : 0;
      const c01 = rawArray[0] || 0;
      const c02 = rawArray[1] || 0;
      const c03 = rawArray[2] || 0;
      const c04 = rawArray[3] || 0;
      const c05 = rawArray[4] || 0;
      const totalSuara = c01 + c02 + c03 + c04 + c05 + suaraTidakSah;

      const { error } = await supabase
        .from('hasil_suara')
        .upsert({
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
        }, { onConflict: 'kecamatan,desa,tps' });

      if (error) {
        await sendMessage(chatId, `❌ Gagal menyimpan data: ${error.message}`);
        return;
      }

      await sendMessage(
        chatId,
        `📊 <b>RINCIAN ANGKA TERCATAT (${tpsTarget})</b>\n\n` +
        `• Calon 01: <b>${c01}</b>\n` +
        `• Calon 02: <b>${c02}</b>\n` +
        `• Calon 03: <b>${c03}</b>\n` +
        (c04 > 0 ? `• Calon 04: <b>${c04}</b>\n` : '') +
        (c05 > 0 ? `• Calon 05: <b>${c05}</b>\n` : '') +
        `• Tidak Sah: <b>${suaraTidakSah}</b>\n` +
        `-------------------------\n` +
        `• Total Suara Masuk: <b>${totalSuara}</b>\n\n` +
        `Langkah 3: Silakan ambil/upload <b>Foto Lembar C1 Plano</b> dari HP Anda.`
      );
      return;
    }

    // ===================================================
    // 7. INPUT FOTO C1 PLANO
    // ===================================================
    if (update.message.photo && update.message.photo.length > 0) {
      const photoObj = update.message.photo[update.message.photo.length - 1];
      const resInfo = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${photoObj.file_id}`);
      const dataFile = await resInfo.json();

      let photoUrl = "";
      if (dataFile.ok) {
        photoUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${dataFile.result.file_path}`;
      }

      const tpsTarget = petugasLogin.tps_aktif || 'TPS 01';

      await supabase
        .from('hasil_suara')
        .update({ url_foto_c1: photoUrl })
        .eq('kecamatan', petugasLogin.kecamatan)
        .eq('desa', petugasLogin.desa)
        .eq('tps', tpsTarget);

      await sendMessage(
        chatId,
        `🎉 <b>PENGIRIMAN DATA SELESAI!</b>\n\n` +
        `Foto C1 Plano untuk <b>${tpsTarget} Desa ${petugasLogin.desa}</b> berhasil diunggah.\n` +
        `Data perolehan suara telah masuk ke Live Count.`
      );
      return;
    }

    // Respon default
    await sendMessage(
      chatId,
      `Ketik <b>/kirimhasil</b> untuk melaporkan hasil suara atau ketik <b>/start</b> untuk menu utama.`
    );

  } catch (err) {
    console.error('Error Webhook:', err);
  }
}