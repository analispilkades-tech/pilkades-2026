const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Helper Telegram Message
async function sendMessage(chatId, text, replyMarkup = null) {
  const payload = { chat_id: chatId, text: text, parse_mode: 'Markdown' };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

// Memory State Sederhana (Atau simpan di DB/Redis jika butuh persisten multi-step)
const userState = {};
const userTemp = {};

module.exports = async (req, res) => {
  // Selalu balas HTTP 200 OK secara instan ke Telegram
  res.status(200).send('OK');

  if (req.method !== 'POST' || !req.body) return;

  const body = req.body;

  try {
    // A. PENANGANAN CALLBACK KEYBOARD (Pilihan TPS)
    if (body.callback_query) {
      const cb = body.callback_query;
      const chatId = cb.message.chat.id;
      const data = cb.data;

      if (data.startsWith("SELECT_TPS_")) {
        const selectedTPS = data.replace("SELECT_TPS_", "");
        const tempData = userTemp[chatId] || {};

        // Cek apakah TPS sudah terisi di database Supabase
        const { data: existing } = await supabase
          .from('hasil_suara')
          .select('id')
          .eq('kecamatan', tempData.kec)
          .eq('desa', tempData.desa)
          .eq('tps', selectedTPS)
          .neq('status_verifikasi', 'REJECTED');

        if (existing && existing.length > 0) {
          await sendMessage(chatId, `⚠️ **${selectedTPS} Desa ${tempData.desa}** sudah pernah dilaporkan. Silakan pilih TPS lain.`);
          return;
        }

        tempData.tps = selectedTPS;
        userTemp[chatId] = tempData;

        // Ambil detail desa
        const { data: dsa } = await supabase
          .from('master_desa')
          .select('jumlah_calon')
          .eq('kecamatan', tempData.kec)
          .eq('desa', tempData.desa)
          .limit(1);

        const jmlCalon = (dsa && dsa.length > 0) ? dsa[0].jumlah_calon : 2;
        let example = "";
        for (let i = 1; i <= jmlCalon; i++) example += `[Calon ${i}]#`;
        example += `[Tidak Sah]`;

        userState[chatId] = "AWAITING_DATA";
        await sendMessage(chatId, `📍 Anda memilih **${selectedTPS} Desa ${tempData.desa}**.\nTerdeteksi: **${jmlCalon} Calon**.\n\nKetik hasil suara dipisah tanda pagar (\`#\`):\nFormat: \`${example}\`\nContoh: \`120#95#5\``);
      }
      return;
    }

    // B. PENANGANAN PESAN TEKS/FOTO TELEGRAM
    if (body.message) {
      const msg = body.message;
      const chatId = msg.chat.id;
      const text = msg.text ? msg.text.trim() : "";

      if (text === "/start") {
        userState[chatId] = "AWAITING_NRP";
        delete userTemp[chatId];
        await sendMessage(chatId, "Selamat datang di **Bot Hitung Cepat Pilkades**.\n\nSilakan masukkan **NRP** Anda untuk verifikasi:");
        return;
      }

      const state = userState[chatId];

      // STEP 1: VERIFIKASI NRP
      if (state === "AWAITING_NRP") {
        const { data: petugas } = await supabase
          .from('master_petugas')
          .select('*')
          .eq('nrp', text)
          .limit(1);

        if (petugas && petugas.length > 0) {
          const p = petugas[0];
          userTemp[chatId] = { nrp: p.nrp, nama: p.nama_petugas, desa: p.desa, kec: p.kecamatan, pin: p.pin };
          userState[chatId] = "AWAITING_PIN";
          await sendMessage(chatId, `Halo, **${p.nama_petugas}**!\nKecamatan: **${p.kecamatan}**\nDesa: **${p.desa}**\n\nMasukkan **PIN Rahasia** Anda:`);
        } else {
          await sendMessage(chatId, "❌ **NRP tidak terdaftar!** Akses ditolak.");
        }
        return;
      }

      // STEP 2: VERIFIKASI PIN & KIRIM TOMBOL TPS
      if (state === "AWAITING_PIN") {
        const tempData = userTemp[chatId] || {};
        if (text === tempData.pin) {
          // Update Chat ID Telegram petugas
          await supabase.from('master_petugas').update({ chat_id_telegram: String(chatId) }).eq('nrp', tempData.nrp);

          // Ambil daftar TPS
          const { data: tpsList } = await supabase
            .from('master_desa')
            .select('tps')
            .eq('kecamatan', tempData.kec)
            .eq('desa', tempData.desa);

          if (!tpsList || tpsList.length === 0) {
            await sendMessage(chatId, "⚠️ Data TPS desa Anda belum disetting di Master Desa.");
            return;
          }

          const keyboard = {
            inline_keyboard: tpsList.map(t => [{ text: `📍 ${t.tps}`, callback_data: `SELECT_TPS_${t.tps}` }])
          };

          userState[chatId] = "AWAITING_TPS_SELECTION";
          await sendMessage(chatId, `✅ **Verifikasi Berhasil!**\nSelamat bertugas, **${tempData.nama}**.\n\nPilih **TPS** yang akan dilaporkan:`, keyboard);
        } else {
          await sendMessage(chatId, "❌ **PIN Salah!** Coba lagi:");
        }
        return;
      }

      // STEP 3: INPUT ANGKA SUARA
      if (state === "AWAITING_DATA") {
        const tempData = userTemp[chatId] || {};
        const parts = text.split("#").map(p => p.trim());

        if (parts.some(p => isNaN(p) || p === "")) {
          await sendMessage(chatId, "⚠️ **Format Salah!** Angka harus dipisah tanda `#`.\nContoh: `120#95#5`");
          return;
        }

        const inputSuara = parts.map(Number);
        const suaraTidakSah = inputSuara.pop();
        const totalSuara = inputSuara.reduce((a, b) => a + b, 0) + suaraTidakSah;

        tempData.suaraCalon = inputSuara;
        tempData.suaraTidakSah = suaraTidakSah;
        tempData.totalSuara = totalSuara;
        userTemp[chatId] = tempData;

        userState[chatId] = "AWAITING_PHOTO";
        await sendMessage(chatId, `📊 **Angka Diterima!** Total Suara: **${totalSuara}**\n\nSekarang, silakan **Kirim Foto C1 Plano**.`);
        return;
      }

      // STEP 4: TERIMA FOTO C1 & SIMPAN KE DB
      if (state === "AWAITING_PHOTO") {
        if (!msg.photo) {
          await sendMessage(chatId, "⚠️ Mohon kirimkan berkas berupa **Foto C1 Plano**.");
          return;
        }

        const photoId = msg.photo[msg.photo.length - 1].file_id;
        
        // Dapatkan Direct URL dari Telegram CDN
        const fileRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${photoId}`);
        const fileJson = await fileRes.json();
        const photoUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileJson.result.file_path}`;

        const tempData = userTemp[chatId] || {};

        // Simpan ke Database Supabase
        await supabase.from('hasil_suara').insert([{
          kecamatan: tempData.kec,
          desa: tempData.desa,
          tps: tempData.tps,
          nrp_saksi: tempData.nrp,
          nama_saksi: tempData.nama,
          suara_calon_01: tempData.suaraCalon[0] || 0,
          suara_calon_02: tempData.suaraCalon[1] || 0,
          suara_calon_03: tempData.suaraCalon[2] || 0,
          suara_calon_04: tempData.suaraCalon[3] || 0,
          suara_calon_05: tempData.suaraCalon[4] || 0,
          suara_tidak_sah: tempData.suaraTidakSah,
          total_suara_masuk: tempData.totalSuara,
          url_foto_c1: photoUrl,
          status_verifikasi: 'AUTO_VERIFIED',
          chat_id_saksi: String(chatId)
        }]);

        delete userState[chatId];
        await sendMessage(chatId, `🎉 **DATA TERKIRIM!** Data hasil **${tempData.tps} Desa ${tempData.desa}** berhasil masuk ke database.`);
      }
    }
  } catch (err) {
    console.error("Error handler:", err);
  }
};