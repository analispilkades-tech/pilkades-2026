# Audit & perbaikan produksi — Pilkades 2026

Tanggal paket: 2026-09-01

## Temuan utama yang diperbaiki

1. **Dua endpoint admin yang tumpang tindih**
   - `admin-action.js` memiliki action `RESET_VERIFIKASI`, sedangkan alur yang dipakai UI adalah `admin-verifikasi.js` dengan `ROLLBACK_VERIFIKASI`.
   - Endpoint duplikat dihapus dari paket agar hanya ada satu jalur mutasi admin.
   - `RESET_VERIFIKASI` tidak lagi menjadi action produksi.

2. **Rollback bukan reset biasa**
   - `ROLLBACK_VERIFIKASI` hanya boleh dilakukan ketika status tepat `VERIFIED_BY_ADMIN`.
   - Wajib alasan rollback 5–1000 karakter.
   - Rollback hanya mengubah status kembali ke `MEMERLUKAN VERIFIKASI ADMIN`; tidak mengembalikan angka secara otomatis.
   - Audit log menyimpan snapshot sebelum/sesudah dan alasan rollback.

3. **Race condition pada verifikasi**
   - Mutasi admin dipindahkan ke RPC PostgreSQL `admin_apply_verification_action`.
   - Target `hasil_suara` dikunci dengan `FOR UPDATE`.
   - Update + audit log terjadi dalam satu transaksi.
   - Dua admin yang menekan aksi terhadap TPS yang sama secara bersamaan tidak dapat sama-sama berhasil.

4. **Public Supabase CRUD terlalu terbuka**
   - Migrasi mencabut privilege `anon` dan `authenticated` pada tabel server-owned.
   - Policy publik lama dihapus.
   - Semua akses database aplikasi dilakukan melalui backend dengan server-only Supabase key.

5. **Public dashboard memakai endpoint admin**
   - `public/index.html` sebelumnya memanggil `/api/get-data`, yang membutuhkan session admin.
   - Ditambahkan `/api/livecount` sebagai endpoint publik read-only.
   - `/api/get-data` tetap khusus admin.

6. **Beban query plano pada polling admin**
   - Sebelumnya seluruh histori `plano_uploads` dibaca lalu difilter di Node.
   - Ditambahkan view `latest_plano_uploads` dan query batch berdasarkan ID TPS.
   - Histori plano tidak lagi diunduh penuh setiap refresh admin.

7. **Webhook Telegram duplicate update**
   - Ditambahkan tabel `telegram_updates` untuk mencegah `update_id` yang sama diproses dua kali.
   - Retensi dedupe 30 hari dijaga dari webhook.
   - Dukungan `TELEGRAM_WEBHOOK_SECRET` ditambahkan.

8. **Session/cookie hardening**
   - Parsing cookie diperbaiki.
   - Cookie tetap `HttpOnly`, `SameSite=Lax`, dan `Secure` pada Vercel.
   - Endpoint mutasi admin/login/logout memeriksa Origin ketika header tersedia.
   - Response admin memakai `no-store` dan security headers.

9. **PIN admin**
   - Ditambahkan migrasi `pin_hash` menggunakan bcrypt via `pgcrypto`.
   - Login sekarang memverifikasi `pin_hash` melalui RPC dan tidak lagi mengambil plaintext PIN dari database.
   - Kolom plaintext `pin` sengaja belum dihapus otomatis agar tidak merusak sistem eksternal; hapus setelah dipastikan tidak digunakan.

10. **XSS pada live dashboard**
    - Nilai database yang dirender ke HTML pada `public/index.html` di-escape.
    - Log ticker menggunakan `textContent`.

## Validasi yang dijalankan

- Semua file backend JavaScript lulus `node --check`.
- Semua inline JavaScript pada `index.html`, `login.html`, dan `admin.html` lulus `node --check`.
- Tidak ada browser/public file yang mengimpor Supabase.
- `RESET_VERIFIKASI` tidak lagi digunakan dalam action production.
- UI admin tetap memanggil `/api/admin-verifikasi` sebagai endpoint mutasi tunggal.

## Catatan penting

Paket kode membutuhkan dua migrasi Supabase sebelum deployment final. Lihat `DEPLOYMENT.md` untuk urutan dan environment variable.

Paket sumber ZIP awal yang dianalisis berisi 14 file, bukan 17 file. Audit dilakukan terhadap seluruh isi ZIP tersebut; file tambahan di paket perbaikan adalah hasil hardening dan pemisahan endpoint.

## UI PANEL ADMIN: SIDEBAR + LIVE COUNT TERBATAS ROLE
- Panel `/admin` kini memiliki sidebar `Audit & Verifikasi`, `Live Count`, dan `Kelola Admin` untuk SUPERADMIN.
- Top bar menampilkan identitas dengan format `Logged as: NAMA (SUPERADMIN)` atau `Logged as: NAMA (ADMIN KECAMATAN)`.
- Tampilan Live Count di panel admin menggunakan tampilan publik yang sama melalui iframe.
- `/api/livecount` tetap publik untuk pengunjung tanpa session, tetapi jika request membawa session admin maka server membatasi `master_desa` dan `hasil_suara` sesuai kecamatan yang diberikan pada `admin_kecamatan`.
- SUPERADMIN tetap dapat melihat seluruh kecamatan.
- Response Live Count untuk session admin menggunakan `Cache-Control: private, no-store` agar data antar-role tidak tersimpan di CDN cache publik.


## Penyempurnaan UI Admin (2026-09-02)
- Sidebar admin dapat di-collapse menjadi rail kecil agar area Live Count/iframe lebih luas.
- Live Count dalam mode `embedded=admin` otomatis memilih kecamatan pertama untuk akun ADMIN_KECAMATAN; jika akun memiliki beberapa kecamatan, kecamatan lain tetap dapat dipilih.
- Menu "Kelola Admin" tidak lagi ditampilkan di sidebar admin; akses Superadmin tetap melalui tombol Superadmin di topbar.
- Setelah login, semua role diarahkan terlebih dahulu ke `/admin`; SUPERADMIN dapat masuk ke `/superadmin` melalui tombol Superadmin di topbar.

## Phase 1 — Canonical Result Engine (2026-10-08)

Database audit confirmed that `hasil_suara` already has a UNIQUE constraint on `(kecamatan, desa, tps)`, so no new duplicate-TPS constraint is required.

A server-only RPC `public.petugas_result_apply(...)` was added in `supabase/20261008_petugas_result_engine.sql`.

Rules implemented:
- `SUBMIT_NEW_RESULT`: creates the first result for a TPS; existing TPS is rejected and never overwritten.
- `CORRECT_OWN_RESULT`: only the NRP that owns the existing result may correct it while the result is not `VERIFIED_BY_ADMIN`.
- `VERIFIED_BY_ADMIN` blocks petugas correction.
- TPS must exist in `master_desa` and petugas location must match the master TPS.
- DPT must be available and total votes may not exceed DPT.
- Insert/correction and `log_aktivitas` are performed in the same database transaction.
- The existing database UNIQUE constraint remains the final race-condition guard.

Telegram manual result confirmation was migrated to this engine. `/edithasil` now lists only the petugas's own unverified results. Plano/OCR direct mutation remains a separate migration step and must not bypass this engine architecture.
