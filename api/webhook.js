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
  // Logika penerimaan format suara 120#80#40#10 dan foto C1
  if (text.startsWith('📍')) {
    const tpsSelected = text.replace('📍', '').trim();
    await sendMessage(
      chatId,
      `Anda memilih <b>${tpsSelected}</b>.\n\n` +
      `Silakan kirimkan data perolehan suara dengan format:\n` +
      `<code>[Suara Calon 01]#[Suara Calon 02]#[Suara Calon 03]#[Suara Tidak Sah]</code>\n\n` +
      `<i>Contoh: 120#80#40#10</i>`
    );
    return;
  }

  if (text.includes('#')) {
    const angka = text.split('#').map(a => parseInt(a.trim()) || 0);
    // Simpan temporary/langsung konfirmasi foto C1
    await sendMessage(
      chatId,
      `✅ Perolehan angka dicatat!\n\n` +
      `Satu langkah lagi: <b>Silakan ambil/upload Foto Lembar C1 Plano</b> dari galeri/kamera HP Anda.`
    );
    return;
  }

  await sendMessage(
    chatId,
    `Halo ${petugas.nama_petugas}, silakan kirim perolehan suara dengan format <code>01#02#03#tidak_sah</code> atau upload foto C1.`
  );
}
