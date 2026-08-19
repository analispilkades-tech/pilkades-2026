import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const BOT_TOKEN = process.env.BOT_TOKEN;

// Helper kirim pesan ke Telegram
async function sendMessage(chatId, text, replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML'
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  const update = req.body;
  if (!update.message) return res.status(200).send('OK');

  const chatId = String(update.message.chat.id);
  const text = update.message.text ? update.message.text.trim() : '';

  try {
    // 1. JIKA USER KETIK /start ATAU /logout
    if (text === '/start' || text === '/logout') {
      // Reset state Telegram di Supabase jika ada
      await supabase
        .from('master_petugas')
        .update({ chat_id_telegram: null })
        .eq('chat_id_telegram', chatId);

      await sendMessage(
        chatId,
        `<b>Selamat Datang di Bot Hitung Cepat Pilkades 2026</b> 🇮🇩\n\nSilakan masukkan <b>NRP</b> Anda untuk verifikasi:`
      );
      return res.status(200).send('OK');
    }

    // 2. CEK APAKAH USER SUDAH TERAUTHENTIKASI (SUDAH LOGIN)
    const { data: petugasLogin } = await supabase
      .from('master_petugas')
      .select('*')
      .eq('chat_id_telegram', chatId)
      .maybeSingle();

    if (petugasLogin) {
      // JIKA SUDAH LOGIN -> TAMPILKAN MENU PILIH TPS / INPUT SUARA
      return await handleInputSuara(chatId, text, petugasLogin, update.message);
    }

    // 3. JIKA BELUM LOGIN -> CEK APAKAH INPUT BERUPA NRP ATAU PIN
    // A. Cek apakah input cocok dengan PIN petugas yang NRP-nya sedang diverifikasi
    // Kita simpan NRP sementara di state/session sederhana, atau cari berdasarkan NRP dulu:
    
    // Apakah text yang diinput adalah NRP?
    const { data: petugasByNrp } = await supabase
      .from('master_petugas')
      .select('*')
      .eq('nrp', text)
      .maybeSingle();

    if (petugasByNrp) {
      // Input cocok dengan NRP! Minta PIN.
      await sendMessage(
        chatId,
        `Halo, <b>${petugasByNrp.nama_petugas}</b>!\n` +
        `Kecamatan: <b>${petugasByNrp.kecamatan}</b>\n` +
        `Desa: <b>${petugasByNrp.desa}</b>\n\n` +
        `Masukkan <b>PIN Rahasia</b> Anda:`
      );
      return res.status(200).send('OK');
    }

    // B. Jika bukan NRP, Cek apakah text yang diinput adalah PIN
    // Cari petugas yang PIN-nya cocok (pencocokan String ketat)
    const { data: petugasByPin } = await supabase
      .from('master_petugas')
      .select('*')
      .eq('pin', text)
      .maybeSingle();

    if (petugasByPin) {
      // PIN COCOK! Simpan chat_id_telegram ke master_petugas (Tanda Login Sukses)
      await supabase
        .from('master_petugas')
        .update({ chat_id_telegram: chatId })
        .eq('nrp', petugasByPin.nrp);

      // Ambil daftar TPS di Desa petugas tersebut dari master_desa
      const { data: daftarTps } = await supabase
        .from('master_desa')
        .select('tps')
        .eq('kecamatan', petugasByPin.kecamatan)
        .eq('desa', petugasByPin.desa);

      let keyboard = [];
      if (daftarTps && daftarTps.length > 0) {
        keyboard = daftarTps.map(t => [{ text: `📍 ${t.tps}` }]);
      } else {
        keyboard = [[{ text: '📍 TPS 01' }], [{ text: '📍 TPS 02' }]];
      }

      await sendMessage(
        chatId,
        `✅ <b>BERHASIL LOGIN!</b>\n\n` +
        `Petugas: <b>${petugasByPin.nama_petugas}</b>\n` +
        `Wilayah: <b>Desa ${petugasByPin.desa}, Kec. ${petugasByPin.kecamatan}</b>\n\n` +
        `Silakan pilih <b>TPS</b> tempat Anda bertugas:`,
        {
          keyboard: keyboard,
          resize_keyboard: true,
          one_time_keyboard: true
        }
      );
      return res.status(200).send('OK');
    }

    // C. Jika bukan NRP dan bukan PIN
    await sendMessage(
      chatId,
      `❌ <b>Akses Ditolak!</b> NRP atau PIN tidak terdaftar.\n\nSilakan masukkan <b>NRP</b> Anda yang valid:`
    );

  } catch (error) {
    console.error('Error Webhook:', error);
  }

  return res.status(200).send('OK');
}

async function handleInputSuara(chatId, text, petugas, message) {
  // A. JIKA PETUGAS MEMILIH TOMBOL TPS (Contoh: "📍 TPS 01" atau "📍 1")
  if (text.startsWith('📍') || text.toLowerCase().startsWith('tps')) {
    const tpsSelected = text.replace('📍', '').trim();

    // Simpan TPS pilihan petugas ke database Supabase sementara
    await supabase
      .from('master_petugas')
      .update({ tps_aktif: tpsSelected })
      .eq('chat_id_telegram', chatId);

    // Ambil jumlah calon dari master_desa untuk memberikan contoh format yang pas
    const { data: dataDesa } = await supabase
      .from('master_desa')
      .select('jumlah_calon')
      .eq('kecamatan', petugas.kecamatan)
      .eq('desa', petugas.desa)
      .maybeSingle();

    const jmlCalon = dataDesa ? dataDesa.jumlah_calon : 3;
    let formatContoh = [];
    for (let i = 1; i <= jmlCalon; i++) {
      formatContoh.push(`[Calon 0${i}]`);
    }
    formatContoh.push(`[Tidak Sah]`);

    await sendMessage(
      chatId,
      `📌 TPS Terpilih: <b>${tpsSelected}</b>\n\n` +
      `Silakan kirimkan perolehan suara dengan format tanda pagar (#):\n` +
      `<code>${formatContoh.join('#')}</code>\n\n` +
      `<i>Contoh untuk ${jmlCalon} calon (${jmlCalon} angka calon + 1 angka tidak sah):</i>\n` +
      `<code>120#80#40#10</code>`
    );
    return;
  }

  // B. JIKA PETUGAS MENGIRIMKAN ANGKA PEROLEHAN SUARA (Mengandung Tanda #)
  if (text.includes('#')) {
    const angkaArray = text.split('#').map(a => parseInt(a.trim()) || 0);

    // Ambil TPS yang sedang aktif dari profil petugas
    const tpsAktif = petugas.tps_aktif || 'TPS 01';

    // Pisahkan angka calon dan suara tidak sah (angka terakhir adalah suara tidak sah)
    const suaraTidakSah = angkaArray.length > 1 ? angkaArray.pop() : 0;
    const c01 = angkaArray[0] || 0;
    const c02 = angkaArray[1] || 0;
    const c03 = angkaArray[2] || 0;
    const c04 = angkaArray[3] || 0;
    const c05 = angkaArray[4] || 0;
    
    const totalSuara = c01 + c02 + c03 + c04 + c05 + suaraTidakSah;

    // Simpan atau Perbarui Hasil Suara di Supabase
    const { error } = await supabase
      .from('hasil_suara')
      .upsert({
        kecamatan: petugas.kecamatan,
        desa: petugas.desa,
        tps: tpsAktif,
        nrp_saksi: petugas.nrp,
        nama_saksi: petugas.nama_petugas,
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
      console.error('Error Upsert Suara:', error);
      await sendMessage(chatId, `❌ Gagal menyimpan data: ${error.message}`);
      return;
    }

    await sendMessage(
      chatId,
      `📊 <b>RINCIAN ANGKA TERCATAT (${tpsAktif})</b>\n\n` +
      `• Calon 01: <b>${c01}</b>\n` +
      `• Calon 02: <b>${c02}</b>\n` +
      `• Calon 03: <b>${c03}</b>\n` +
      (c04 > 0 ? `• Calon 04: <b>${c04}</b>\n` : '') +
      (c05 > 0 ? `• Calon 05: <b>${c05}</b>\n` : '') +
      `• Tidak Sah: <b>${suaraTidakSah}</b>\n` +
      `-------------------------\n` +
      `• Total Suara Masuk: <b>${totalSuara}</b>\n\n` +
      `📸 <b>LANGKAH TERAKHIR:</b>\n` +
      `Silakan ambil/kirimkan <b>Foto Lembar C1 Plano</b> dari kamera HP Anda.`
    );
    return;
  }

  // C. JIKA PETUGAS MENGIRIM FOTO LEMBAR C1
  if (message.photo && message.photo.length > 0) {
    // Ambil file_id foto ukuran terbesar dari Telegram
    const photoObj = message.photo[message.photo.length - 1];
    const fileId = photoObj.file_id;

    // Dapatkan URL foto dari Telegram API
    const resFile = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
    const dataFile = await resFile.json();

    let photoUrl = "";
    if (dataFile.ok) {
      photoUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${dataFile.result.file_path}`;
    }

    const tpsAktif = petugas.tps_aktif || 'TPS 01';

    // Update URL foto C1 ke Supabase
    await supabase
      .from('hasil_suara')
      .update({ url_foto_c1: photoUrl })
      .eq('kecamatan', petugas.kecamatan)
      .eq('desa', petugas.desa)
      .eq('tps', tpsAktif);

    await sendMessage(
      chatId,
      `🎉 <b>PENGIRIMAN DATA SELESAI!</b>\n\n` +
      `Foto C1 Plano untuk <b>${tpsAktif} Desa ${petugas.desa}</b> berhasil diunggah.\n` +
      `Data perolehan suara secara otomatis telah masuk ke <b>Live Count Dasbor Publik & Panel Admin</b>.`
    );
    return;
  }

  // PANDUAN DEFAUT JIKA INPUT TIDAK DIKENALI
  await sendMessage(
    chatId,
    `Silakan kirimkan perolehan angka suara dengan format <code>01#02#03#tidak_sah</code> atau upload foto C1 Plano.`
  );
}
