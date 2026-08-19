const BOT_TOKEN = "8948078141:AAEzbPNe8hjP-9ZwhPo874xr4CchLzCwr5I";
const SHEET_PETUGAS = "Master_Petugas";
const SHEET_DESA = "Master_Desa";
const SHEET_HASIL = "Hasil_Suara";

// Menangkap Pesan dari Telegram
function doPost(e) {
  const contents = JSON.parse(e.postData.contents);
  if (!contents.message) return;
  
  const chatId = contents.message.chat.id;
  const text = contents.message.text ? contents.message.text.trim() : "";
  
  // Fitur /start
  if (text === "/start") {
    sendMessage(chatId, "Selamat datang di Bot Hitung Cepat Pilkades.\n\nSilakan masukkan **NRP** Anda untuk verifikasi identitas:");
    setUserState(chatId, "AWAITING_NRP");
    return;
  }
  
  let state = getUserState(chatId);
  
  // Step 1: Cek NRP
  if (state === "AWAITING_NRP") {
    let petugas = findPetugasByNRP(text);
    if (petugas) {
      setUserTempData(chatId, { nrp: text, nama: petugas.nama, desa: petugas.desa, tps: petugas.tps, kec: petugas.kec });
      sendMessage(chatId, `Halo, **${petugas.nama}**!\nKecamatan: ${petugas.kec}\nDesa: ${petugas.desa} (${petugas.tps})\n\nSilakan masukkan **PIN Rahasia** Anda:`);
      setUserState(chatId, "AWAITING_PIN");
    } else {
      sendMessage(chatId, "❌ **NRP tidak terdaftar!** Akses ditolak. Silakan cek kembali NRP Anda.");
    }
    return;
  }
  
  // Step 2: Cek PIN & Tampilkan Calon Dinamis
  if (state === "AWAITING_PIN") {
    let tempData = getUserTempData(chatId);
    let isPinValid = verifyPIN(tempData.nrp, text);
    
    if (isPinValid) {
      saveChatIdToPetugas(tempData.nrp, chatId); // Kunci Chat ID
      let detailDesa = getDetailDesa(tempData.kec, tempData.desa, tempData.tps);
      
      let msgCalon = `✅ **Verifikasi Berhasil!**\nSelamat bertugas, **${tempData.nama}**.\n\n`;
      msgCalon += `Terdeteksi **${detailDesa.jumlahCalon} Calon** di Desa ${tempData.desa}.\n\n`;
      msgCalon += `Ketik hasil suara dengan format dipisah tanda pagar (#):\n`;
      
      let formatExample = "";
      for (let i = 1; i <= detailDesa.jumlahCalon; i++) {
        formatExample += `[Suara Calon ${i}]#`;
      }
      formatExample += `[Suara Tidak Sah]`;
      
      msgCalon += `\nFormat: \`${formatExample}\`\nContoh: \`120#95#5\``;
      
      sendMessage(chatId, msgCalon);
      setUserState(chatId, "AWAITING_DATA");
    } else {
      sendMessage(chatId, "❌ **PIN Salah!** Coba lagi:");
    }
    return;
  }
}

// Helper Function: Kirim Pesan WA/Telegram
function sendMessage(chatId, text) {
  let url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  let payload = {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown"
  };
  UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload)
  });
}

// (Fungsi pendukung database State/PropertiesService disesuaikan)

function doGet(e) {
  let sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_HASIL);
  let data = sheet.getDataRange().getValues();
  let headers = data.shift();
  
  let result = data.map(row => {
    let obj = {};
    headers.forEach((header, index) => {
      obj[header] = row[index];
    });
    return obj;
  });
  
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}
