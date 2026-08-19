// ==========================================
// KONFIGURASI UTAMA
// ==========================================
const BOT_TOKEN = "8948078141:AAEzbPNe8hjP-9ZwhPo874xr4CchLzCwr5I"; // Ganti dengan Token Bot Telegram Anda

const SHEET_PETUGAS = "Master_Petugas";
const SHEET_DESA = "Master_Desa";
const SHEET_HASIL = "Hasil_Suara";
const SHEET_ADMIN = "Master_Admin";

// ==========================================
// 1. HANDLER WEB HOOK & WEB API (doPost & doGet)
// ==========================================

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput("No post data");
    }

    const postData = JSON.parse(e.postData.contents);

    // A. PENANGANAN REQUEST DARI ADMIN / API VERCEL
    if (postData.action) {
      if (postData.action === "login") {
        return handleLogin(postData);
      }
      if (postData.action === "updateStatus") {
        return handleAdminAction(postData);
      }
    }

    // B. PENANGANAN CALLBACK KEYBOARD TELEGRAM (Pilihan TPS)
    if (postData.callback_query) {
      handleCallbackQuery(postData.callback_query);
      return ContentService.createTextOutput("OK");
    }

    // C. PENANGANAN PESAN TELEGRAM DARI PETUGAS
    if (postData.message) {
      handleTelegramMessage(postData.message);
      return ContentService.createTextOutput("OK");
    }

  } catch (err) {
    Logger.log("Error doPost: " + err.toString());
    return ContentService.createTextOutput("Error: " + err.toString());
  }
}

function doGet(e) {
  let action = e ? e.parameter.action : "";

  if (action === "getAuditData" || action === "getLiveData") {
    let sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_HASIL);
    if (!sheet) return responseJSON([]);
    
    let data = sheet.getDataRange().getValues();
    if (data.length <= 1) return responseJSON([]);
    
    let headers = data.shift();
    let result = data.map(row => {
      let obj = {};
      headers.forEach((h, i) => obj[h] = row[i]);
      return obj;
    });

    return responseJSON(result);
  }

  return ContentService.createTextOutput("Engine Pilkades Active.");
}

// ==========================================
// 2. LOGIKA TELEGRAM BOT
// ==========================================

function handleTelegramMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : "";

  // Perintah /start
  if (text === "/start") {
    setUserState(chatId, "AWAITING_NRP");
    deleteUserTempData(chatId);
    sendMessage(chatId, "Selamat datang di **Bot Hitung Cepat Pilkades**.\n\nSilakan masukkan **NRP** Anda untuk verifikasi identitas:");
    return;
  }

  let state = getUserState(chatId);

  // STEP 1: Verifikasi NRP
  if (state === "AWAITING_NRP") {
    let petugas = findPetugasByNRP(text);
    if (petugas) {
      setUserTempData(chatId, { nrp: text, nama: petugas.nama, desa: petugas.desa, kec: petugas.kec });
      sendMessage(chatId, `Halo, **${petugas.nama}**!\nKecamatan: **${petugas.kec}**\nDesa: **${petugas.desa}**\n\nSilakan masukkan **PIN Rahasia** Anda:`);
      setUserState(chatId, "AWAITING_PIN");
    } else {
      sendMessage(chatId, "❌ **NRP tidak terdaftar!** Akses ditolak. Silakan cek kembali NRP Anda.");
    }
    return;
  }

  // STEP 2: Verifikasi PIN & Tampilkan Pilihan TPS
  if (state === "AWAITING_PIN") {
    let tempData = getUserTempData(chatId);
    let isPinValid = verifyPIN(tempData.nrp, text);

    if (isPinValid) {
      saveChatIdToPetugas(tempData.nrp, chatId);
      let listTPS = getTPSByDesa(tempData.kec, tempData.desa);
      
      if (listTPS.length === 0) {
        sendMessage(chatId, "⚠️ Data TPS untuk desa Anda belum dikonfigurasi di Master Desa. Hubungi Panitia.");
        return;
      }

      sendInlineKeyboard(chatId, 
        `✅ **Verifikasi Berhasil!**\nSelamat bertugas, **${tempData.nama}**.\n\nSilakan pilih **TPS** yang ingin Anda laporkan hasilnya saat ini:`, 
        listTPS
      );
      setUserState(chatId, "AWAITING_TPS_SELECTION");
    } else {
      sendMessage(chatId, "❌ **PIN Salah!** Coba lagi:");
    }
    return;
  }

  // STEP 3: Menerima Input Perolehan Suara
  if (state === "AWAITING_DATA") {
    let tempData = getUserTempData(chatId);
    let detailDesa = getDetailDesa(tempData.kec, tempData.desa);
    
    let parts = text.split("#").map(p => p.trim());
    let expectedCount = detailDesa.jumlahCalon + 1; // Calon + Suara Tidak Sah

    if (parts.length !== expectedCount || parts.some(p => isNaN(p) || p === "")) {
      sendMessage(chatId, `⚠️ **Format Salah!** Harus ada ${expectedCount} angka dipisah tanda \`#\`.\nContoh: \`120#95#5\``);
      return;
    }

    // Ekstrak Angka Suara
    let inputSuara = parts.map(Number);
    let suaraTidakSah = inputSuara.pop();
    let totalSuara = inputSuara.reduce((a, b) => a + b, 0) + suaraTidakSah;

    // Simpan Sementara Data Angka Suara
    tempData.suaraCalon = inputSuara;
    tempData.suaraTidakSah = suaraTidakSah;
    tempData.totalSuara = totalSuara;
    setUserTempData(chatId, tempData);

    setUserState(chatId, "AWAITING_PHOTO");
    sendMessage(chatId, `📊 **Angka Suara Diterima!**\nTotal Suara Masuk: **${totalSuara}**\n\nSekarang, silakan **Kirim Foto C1 Plano** dari TPS tersebut.`);
    return;
  }

  // STEP 4: Menerima Foto C1
  if (state === "AWAITING_PHOTO") {
    if (!msg.photo) {
      sendMessage(chatId, "⚠️ Mohon kirimkan berkas berupa **Foto/Gambar C1 Plano**.");
      return;
    }

    // Ambil foto ukuran terbesar
    let photoObj = msg.photo[msg.photo.length - 1];
    let fileUrl = getTelegramFileUrl(photoObj.file_id);

    let tempData = getUserTempData(chatId);
    tempData.photoUrl = fileUrl;

    // Simpan ke Google Sheets
    saveHasilToSheet(tempData);

    sendMessage(chatId, `🎉 **DATA TERKIRIM & DIVERIFIKASI!**\n\nTerima kasih, **${tempData.nama}**. Data hasil perolehan suara **${tempData.tps} Desa ${tempData.desa}** telah masuk ke database pusat.`);
    
    // Reset state agar petugas bisa memilih TPS lain di desanya jika ada
    setUserState(chatId, "AWAITING_TPS_SELECTION");
    let listTPS = getTPSByDesa(tempData.kec, tempData.desa);
    sendInlineKeyboard(chatId, "Apakah Anda ingin melaporkan hasil TPS lainnya di desa Anda?", listTPS);
    return;
  }
}

// Handler Pilihan Tombol TPS
function handleCallbackQuery(cb) {
  const chatId = cb.message.chat.id;
  const data = cb.data;

  if (data.startsWith("SELECT_TPS_")) {
    let selectedTPS = data.replace("SELECT_TPS_", "");
    let tempData = getUserTempData(chatId);
    
    // Cek apakah TPS ini sudah diisi di sheet Hasil_Suara
    if (isTPSAlreadySubmitted(tempData.kec, tempData.desa, selectedTPS)) {
      sendMessage(chatId, `⚠️ **${selectedTPS} Desa ${tempData.desa}** sudah pernah dilaporkan dan terverifikasi. Silakan pilih TPS lain.`);
      return;
    }

    tempData.tps = selectedTPS;
    setUserTempData(chatId, tempData);

    let detailDesa = getDetailDesa(tempData.kec, tempData.desa);
    let formatExample = "";
    for (let i = 1; i <= detailDesa.jumlahCalon; i++) {
      formatExample += `[Calon ${i}]#`;
    }
    formatExample += `[Tidak Sah]`;

    setUserState(chatId, "AWAITING_DATA");
    sendMessage(chatId, `📍 Anda memilih **${selectedTPS} Desa ${tempData.desa}**.\nTerdeteksi: **${detailDesa.jumlahCalon} Calon**.\n\nKetik hasil suara dipisah tanda pagar (\`#\`):\nFormat: \`${formatExample}\`\nContoh: \`120#95#5\``);
  }
}

// ==========================================
// 3. HANDLER ADMIN & AUTENTIKASI
// ==========================================

function handleLogin(data) {
  let sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ADMIN);
  if (!sheet) return responseJSON({ success: false, message: "Sheet Admin tidak ditemukan" });

  let rows = sheet.getDataRange().getValues();
  rows.shift(); // Hapus header

  let foundUser = rows.find(row => String(row[0]) === String(data.username) && String(row[1]) === String(data.password));

  if (foundUser) {
    let token = Utilities.base64Encode(data.username + ":" + new Date().getTime());
    return responseJSON({
      success: true,
      token: token,
      nama: foundUser[2],
      role: foundUser[3]
    });
  } else {
    return responseJSON({ success: false, message: "Username atau Password salah!" });
  }
}

function handleAdminAction(data) {
  let sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_HASIL);
  if (!sheet) return responseJSON({ success: false, message: "Sheet Hasil tidak ditemukan" });

  let rows = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][2] === data.desa && rows[i][3] === data.tps) {
      sheet.getRange(i + 1, 15).setValue(data.status); // Kolom O (Status_Verifikasi)

      if (data.status === "REJECTED") {
        let chatIdSaksi = rows[i][15]; // Kolom P (Chat_ID)
        if (chatIdSaksi) {
          sendMessage(chatIdSaksi, `⚠️ **DATA ${data.tps} DESA ${data.desa} DITOLAK VERIFIKATOR**\n\nMohon periksa kembali foto C1 dan masukkan ulang data yang benar.`);
        }
      }
      return responseJSON({ success: true, message: "Status diperbarui" });
    }
  }
  return responseJSON({ success: false, message: "Data TPS tidak ditemukan" });
}

// ==========================================
// 4. DATABASE & HELPER FUNCTIONS
// ==========================================

function findPetugasByNRP(nrp) {
  let sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PETUGAS);
  let data = sheet.getDataRange().getValues();
  data.shift();

  let found = data.find(r => String(r[0]).trim() === String(nrp).trim());
  if (found) {
    return { nrp: found[0], nama: found[1], kec: found[2], desa: found[3], pin: found[4] };
  }
  return null;
}

function verifyPIN(nrp, pin) {
  let petugas = findPetugasByNRP(nrp);
  return petugas && String(petugas.pin).trim() === String(pin).trim();
}

function saveChatIdToPetugas(nrp, chatId) {
  let sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PETUGAS);
  let data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(nrp).trim()) {
      sheet.getRange(i + 1, 6).setValue(chatId); // Kolom F
      break;
    }
  }
}

function getTPSByDesa(kec, desa) {
  let sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_DESA);
  let data = sheet.getDataRange().getValues();
  data.shift();

  let tpsList = data
    .filter(r => String(r[0]).trim() === String(kec).trim() && String(r[1]).trim() === String(desa).trim())
    .map(r => r[2]);

  return [...new Set(tpsList)];
}

function getDetailDesa(kec, desa) {
  let sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_DESA);
  let data = sheet.getDataRange().getValues();
  data.shift();

  let found = data.find(r => String(r[0]).trim() === String(kec).trim() && String(r[1]).trim() === String(desa).trim());
  if (found) {
    return { dpt: found[3], jumlahCalon: Number(found[4]) || 2 };
  }
  return { dpt: 0, jumlahCalon: 2 };
}

function isTPSAlreadySubmitted(kec, desa, tps) {
  let sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_HASIL);
  if (!sheet) return false;
  let data = sheet.getDataRange().getValues();
  data.shift();

  return data.some(r => r[1] === kec && r[2] === desa && r[3] === tps && r[14] !== "REJECTED");
}

function saveHasilToSheet(d) {
  let sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_HASIL);
  
  let c1 = d.suaraCalon[0] || 0;
  let c2 = d.suaraCalon[1] || 0;
  let c3 = d.suaraCalon[2] || 0;
  let c4 = d.suaraCalon[3] || 0;
  let c5 = d.suaraCalon[4] || 0;

  sheet.appendRow([
    new Date(),
    d.kec,
    d.desa,
    d.tps,
    d.nrp,
    d.nama,
    c1,
    c2,
    c3,
    c4,
    c5,
    d.suaraTidakSah,
    d.totalSuara,
    d.photoUrl,
    "AUTO_VERIFIED",
    d.chatId || ""
  ]);
}

// ==========================================
// 5. TELEGRAM API UTILITIES
// ==========================================

function sendMessage(chatId, text) {
  UrlFetchApp.fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "Markdown" })
  });
}

function sendInlineKeyboard(chatId, text, listTPS) {
  let keyboard = listTPS.map(tps => [{ text: `📍 ${tps}`, callback_data: `SELECT_TPS_${tps}` }]);
  
  UrlFetchApp.fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
      reply_markup: JSON.stringify({ inline_keyboard: keyboard })
    })
  });
}

function getTelegramFileUrl(fileId) {
  let res = UrlFetchApp.fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
  let json = JSON.parse(res.getContentText());
  if (json.ok) {
    return `https://api.telegram.org/file/bot${BOT_TOKEN}/${json.result.file_path}`;
  }
  return "";
}

// ==========================================
// 6. MANAGEMENT SESSION (PropertiesService)
// ==========================================

function setUserState(chatId, state) {
  PropertiesService.getScriptProperties().setProperty("STATE_" + chatId, state);
}

function getUserState(chatId) {
  return PropertiesService.getScriptProperties().getProperty("STATE_" + chatId) || "";
}

function setUserTempData(chatId, data) {
  data.chatId = chatId;
  PropertiesService.getScriptProperties().setProperty("TEMP_" + chatId, JSON.stringify(data));
}

function getUserTempData(chatId) {
  let raw = PropertiesService.getScriptProperties().getProperty("TEMP_" + chatId);
  return raw ? JSON.parse(raw) : {};
}

function deleteUserTempData(chatId) {
  PropertiesService.getScriptProperties().deleteProperty("TEMP_" + chatId);
}

function responseJSON(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
