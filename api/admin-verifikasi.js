<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <title>Panel Admin & Audit Pilkades 2026</title>

  <script src="https://cdn.tailwindcss.com"></script>
</head>

<body class="bg-slate-900 text-slate-100 min-h-screen flex flex-col font-sans">

  <!-- =====================================================
       HEADER
  ====================================================== -->

  <header class="bg-slate-800 border-b border-slate-700 p-4 shadow-lg">

    <div class="max-w-7xl mx-auto flex justify-between items-center">

      <div>

        <span
          class="text-xs font-bold text-blue-400 uppercase tracking-widest">
          Polres Wonosobo
        </span>

        <h1 class="text-xl font-extrabold text-white">
          PANEL AUDIT & VERIFIKASI C1
        </h1>

      </div>

      <div class="flex items-center space-x-4">

        <span
          id="adminNameDisplay"
          class="text-xs text-slate-300 font-mono hidden md:inline">
          Logged as: Admin
        </span>

        <button
          onclick="logoutAdmin()"
          class="bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold px-3 py-2 rounded-lg transition">

          Keluar (Logout)

        </button>

      </div>

    </div>

  </header>


  <!-- =====================================================
       MAIN
  ====================================================== -->

  <main class="max-w-7xl mx-auto p-4 md:p-6 w-full flex-grow">


    <!-- ===================================================
         STATISTIK / FILTER
    ==================================================== -->

    <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">


      <!-- PENDING -->

      <button
        onclick="setFilterStatus('PENDING')"
        id="tabPending"
        class="bg-slate-800 hover:bg-slate-700 border border-amber-500/50 p-4 rounded-xl text-left transition shadow-md">

        <div class="text-xs text-amber-400 font-semibold uppercase">
          ⚠️ Perlu Audit / Review
        </div>

        <div
          id="countPending"
          class="text-2xl font-extrabold text-white mt-1">
          0 TPS
        </div>

      </button>


      <!-- VERIFIED -->

      <button
        onclick="setFilterStatus('VERIFIED')"
        id="tabVerified"
        class="bg-slate-800 hover:bg-slate-700 border border-emerald-500/50 p-4 rounded-xl text-left transition shadow-md">

        <div class="text-xs text-emerald-400 font-semibold uppercase">
          ✅ Terverifikasi / Sah
        </div>

        <div
          id="countVerified"
          class="text-2xl font-extrabold text-white mt-1">
          0 TPS
        </div>

      </button>


      <!-- ALL -->

      <button
        onclick="setFilterStatus('ALL')"
        id="tabAll"
        class="bg-slate-800 hover:bg-slate-700 border border-blue-500/50 p-4 rounded-xl text-left transition shadow-md">

        <div class="text-xs text-blue-400 font-semibold uppercase">
          📋 Semua Data Livecount
        </div>

        <div
          id="countAll"
          class="text-2xl font-extrabold text-white mt-1">
          0 TPS
        </div>

      </button>

    </div>


    <!-- ===================================================
         TABEL
    ==================================================== -->

    <div
      class="bg-slate-800 rounded-2xl border border-slate-700 shadow-xl p-6">


      <!-- TITLE + SEARCH -->

      <div
        class="flex flex-col md:flex-row justify-between items-center mb-4 gap-3">

        <h2
          id="tableTitle"
          class="text-lg font-bold text-white">

          Daftar Data Masuk

        </h2>


        <input
          type="text"
          id="searchQuery"
          oninput="applyTableFilter()"
          placeholder="Cari Desa / Kecamatan / Petugas..."
          class="p-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-white w-full md:w-72 focus:outline-none focus:ring-2 focus:ring-blue-500">

      </div>


      <!-- TABLE -->

      <div class="overflow-x-auto">

        <table
          class="w-full text-left text-sm border-collapse">

          <thead>

            <tr
              class="bg-slate-900/50 text-slate-400 border-b border-slate-700">

              <th class="p-3">
                Lokasi
              </th>

              <th class="p-3">
                Petugas
              </th>

              <th class="p-3 text-center">
                Perolehan Suara
              </th>

              <th class="p-3 text-center">
                Total
              </th>

              <th class="p-3 text-center">
                Status
              </th>

              <th class="p-3 text-center">
                Foto Plano
              </th>

              <th class="p-3 text-center">
                Aksi Admin
              </th>

            </tr>

          </thead>


          <tbody
            id="adminTableBody"
            class="divide-y divide-slate-700/50 text-slate-300">

            <tr>

              <td
                colspan="7"
                class="text-center py-8 text-slate-500">

                Memuat data audit...

              </td>

            </tr>

          </tbody>

        </table>

      </div>

    </div>

  </main>


  <!-- =====================================================
       FOOTER
  ====================================================== -->

  <footer
    class="bg-slate-950 border-t border-slate-800 py-4 text-center text-xs text-slate-500">

    <p>
      &copy; 2026 brengos ntd.
      Sistem Pengamanan & Audit Pilkades Polres Wonosobo.
    </p>

  </footer>


  <!-- =====================================================
       MODAL UBAH DATA
  ====================================================== -->

  <div
    id="editModal"
    class="fixed inset-0 bg-black/70 hidden items-center justify-center z-50 p-4">

    <div
      class="bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-lg">


      <!-- MODAL HEADER -->

      <div
        class="p-5 border-b border-slate-700">

        <h3
          class="text-lg font-bold text-white">

          ✏️ Ubah Data Hasil Suara

        </h3>

        <p
          id="editLocation"
          class="text-xs text-slate-400 mt-1">

          -

        </p>

      </div>


      <!-- FORM -->

      <div class="p-5 space-y-4">


        <!-- CALON 01 -->

        <div>

          <label
            class="block text-xs text-slate-400 mb-1">

            Calon 01

          </label>

          <input
            id="editCalon01"
            type="number"
            min="0"
            step="1"
            class="edit-input">

        </div>


        <!-- CALON 02 -->

        <div>

          <label
            class="block text-xs text-slate-400 mb-1">

            Calon 02

          </label>

          <input
            id="editCalon02"
            type="number"
            min="0"
            step="1"
            class="edit-input">

        </div>


        <!-- CALON 03 -->

        <div>

          <label
            class="block text-xs text-slate-400 mb-1">

            Calon 03

          </label>

          <input
            id="editCalon03"
            type="number"
            min="0"
            step="1"
            class="edit-input">

        </div>


        <!-- CALON 04 -->

        <div>

          <label
            class="block text-xs text-slate-400 mb-1">

            Calon 04

          </label>

          <input
            id="editCalon04"
            type="number"
            min="0"
            step="1"
            class="edit-input">

        </div>


        <!-- CALON 05 -->

        <div>

          <label
            class="block text-xs text-slate-400 mb-1">

            Calon 05

          </label>

          <input
            id="editCalon05"
            type="number"
            min="0"
            step="1"
            class="edit-input">

        </div>


        <!-- TIDAK SAH -->

        <div>

          <label
            class="block text-xs text-slate-400 mb-1">

            Suara Tidak Sah

          </label>

          <input
            id="editTidakSah"
            type="number"
            min="0"
            step="1"
            class="edit-input">

        </div>


        <!-- TOTAL PREVIEW -->

        <div
          class="bg-slate-900 border border-slate-700 rounded-xl p-4">

          <div class="flex justify-between">

            <span class="text-slate-400 text-sm">
              Total suara
            </span>

            <span
              id="editTotal"
              class="text-xl font-extrabold text-emerald-400">

              0

            </span>

          </div>

          <p
            class="text-xs text-slate-500 mt-1">

            Total dihitung kembali oleh server.

          </p>

        </div>

      </div>


      <!-- MODAL BUTTON -->

      <div
        class="p-5 border-t border-slate-700 flex justify-end gap-3">

        <button
          onclick="closeEditModal()"
          class="bg-slate-700 hover:bg-slate-600 px-4 py-2 rounded-lg text-sm font-bold">

          Batal

        </button>

        <button
          onclick="submitEditData()"
          class="bg-emerald-600 hover:bg-emerald-700 px-4 py-2 rounded-lg text-sm font-bold text-white">

          💾 Simpan & Sahkan

        </button>

      </div>

    </div>

  </div>


  <!-- =====================================================
       JAVASCRIPT
  ====================================================== -->

  <script>


    /* ====================================================
       GLOBAL
    ==================================================== */

    let globalData = [];

    let currentFilter = 'PENDING';

    let editingId = null;


    /* ====================================================
       INIT
    ==================================================== */

    document.addEventListener(
      "DOMContentLoaded",
      () => {

        const adminNama =
          localStorage.getItem("adminNama") ||
          "Admin";

        document.getElementById(
          "adminNameDisplay"
        ).innerText =
          `Logged as: ${adminNama}`;


        fetchAdminData();


        /*
         * Refresh setiap 10 detik.
         *
         * OCR tetap berjalan di backend.
         * Dashboard hanya membaca status terbaru.
         */

        setInterval(
          fetchAdminData,
          10000
        );

      }
    );


    /* ====================================================
       FETCH DATA
    ==================================================== */

    async function fetchAdminData() {

      try {

        const res =
          await fetch('/api/get-data');


        const result =
          await res.json();


        if (!res.ok) {

          throw new Error(
            result.error ||
            'Gagal mengambil data'
          );

        }


        globalData =
          result.data ||
          result ||
          [];


        updateTabCounts();

        applyTableFilter();

      } catch (err) {

        console.error(
          "Gagal memuat data admin:",
          err
        );

      }

    }


    /* ====================================================
       FILTER TAB
    ==================================================== */

    function setFilterStatus(status) {

      currentFilter =
        status;

      applyTableFilter();

    }


    /* ====================================================
       COUNT
    ==================================================== */

    function updateTabCounts() {

      const pendingStatuses = [

        'PLANO TIDAK SESUAI',

        'FOTO PLANO BELUM TERVERIFIKASI',

        'MEMERLUKAN VERIFIKASI ADMIN'

      ];


      const verifiedStatuses = [

        'AUTO VERIFIED',

        'AUTO_VERIFIED',

        'EDITED_BY_SAKSI',

        'VERIFIED_BY_ADMIN'

      ];


      const pendingCount =
        globalData.filter(
          d =>
            pendingStatuses.includes(
              d.status_verifikasi
            )
        ).length;


      const verifiedCount =
        globalData.filter(
          d =>
            verifiedStatuses.includes(
              d.status_verifikasi
            )
        ).length;


      document.getElementById(
        "countPending"
      ).innerText =
        `${pendingCount} TPS`;


      document.getElementById(
        "countVerified"
      ).innerText =
        `${verifiedCount} TPS`;


      document.getElementById(
        "countAll"
      ).innerText =
        `${globalData.length} TPS`;

    }


    /* ====================================================
       TABLE FILTER
    ==================================================== */

    function applyTableFilter() {

      const search =
        document
          .getElementById(
            "searchQuery"
          )
          .value
          .toLowerCase();


      const pendingStatuses = [

        'PLANO TIDAK SESUAI',

        'FOTO PLANO BELUM TERVERIFIKASI',

        'MEMERLUKAN VERIFIKASI ADMIN'

      ];


      const verifiedStatuses = [

        'AUTO VERIFIED',

        'AUTO_VERIFIED',

        'EDITED_BY_SAKSI',

        'VERIFIED_BY_ADMIN'

      ];


      const filtered =
        globalData.filter(
          item => {


            const matchSearch =

              String(
                item.desa || ''
              )
              .toLowerCase()
              .includes(search)

              ||

              String(
                item.kecamatan || ''
              )
              .toLowerCase()
              .includes(search)

              ||

              String(
                item.nama_saksi || ''
              )
              .toLowerCase()
              .includes(search);


            if (!matchSearch) {

              return false;

            }


            if (
              currentFilter ===
              'PENDING'
            ) {

              return pendingStatuses.includes(
                item.status_verifikasi
              );

            }


            if (
              currentFilter ===
              'VERIFIED'
            ) {

              return verifiedStatuses.includes(
                item.status_verifikasi
              );

            }


            return true;

          }
        );


      renderAdminTable(
        filtered
      );

    }


    /* ====================================================
       ESCAPE HTML
    ==================================================== */

    function escapeHtml(value) {

      return String(
        value ?? ''
      )

        .replace(
          /&/g,
          '&amp;'
        )

        .replace(
          /</g,
          '&lt;'
        )

        .replace(
          />/g,
          '&gt;'
        )

        .replace(
          /"/g,
          '&quot;'
        )

        .replace(
          /'/g,
          '&#039;'
        );

    }


    /* ====================================================
       STATUS BADGE
    ==================================================== */

    function statusBadge(status) {

      status =
        status ||
        'PENDING';


      let cls =
        'bg-slate-700 text-slate-300';


      if (
        status ===
        'MEMERLUKAN VERIFIKASI ADMIN'
      ) {

        cls =
          'bg-amber-900/50 text-amber-300 border border-amber-700';

      }


      if (
        status ===
        'PLANO TIDAK SESUAI'
      ) {

        cls =
          'bg-red-900/50 text-red-300 border border-red-700';

      }


      if (
        status ===
        'FOTO PLANO BELUM TERVERIFIKASI'
      ) {

        cls =
          'bg-orange-900/50 text-orange-300 border border-orange-700';

      }


      if (
        status ===
        'VERIFIED_BY_ADMIN'
      ) {

        cls =
          'bg-emerald-900/50 text-emerald-300 border border-emerald-700';

      }


      if (
        status ===
        'AUTO VERIFIED' ||
        status ===
        'AUTO_VERIFIED'
      ) {

        cls =
          'bg-blue-900/50 text-blue-300 border border-blue-700';

      }


      return `
        <span
          class="px-2 py-1 ${cls} rounded text-xs font-bold whitespace-nowrap">

          ${escapeHtml(status)}

        </span>
      `;

    }


    /* ====================================================
       RENDER TABLE
    ==================================================== */

    function renderAdminTable(data) {

      const tbody =
        document.getElementById(
          "adminTableBody"
        );


      tbody.innerHTML = "";


      if (
        data.length === 0
      ) {

        tbody.innerHTML = `

          <tr>

            <td
              colspan="7"
              class="text-center py-8 text-slate-500">

              Tidak ada data dalam kategori ini.

            </td>

          </tr>

        `;

        return;

      }


      data.forEach(
        item => {


          const photoLink =
            item.google_drive_url

              ? `

                <a
                  href="${escapeHtml(item.google_drive_url)}"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg text-xs font-bold inline-block shadow">

                  📁 Buka Foto

                </a>

              `

              :

              `

                <span
                  class="text-slate-500 text-xs italic">

                  Belum Ada Foto

                </span>

              `;


          const aksi =
            renderActionButtons(
              item
            );


          tbody.innerHTML += `

            <tr
              class="hover:bg-slate-700/30 transition align-top">


              <!-- LOKASI -->

              <td class="p-3">

                <strong
                  class="text-white">

                  ${escapeHtml(
                    item.desa || '-'
                  )}

                </strong>

                <br>

                <span
                  class="text-xs text-slate-400">

                  Kec.
                  ${escapeHtml(
                    item.kecamatan || '-'
                  )}

                  • TPS
                  ${escapeHtml(
                    item.tps || '-'
                  )}

                </span>

              </td>


              <!-- PETUGAS -->

              <td
                class="p-3 text-xs">

                ${escapeHtml(
                  item.nama_saksi || '-'
                )}

                <br>

                <span
                  class="text-slate-500">

                  NRP:
                  ${escapeHtml(
                    item.nrp_saksi || '-'
                  )}

                </span>

              </td>


              <!-- SUARA -->

              <td
                class="p-3 text-center font-mono text-xs whitespace-nowrap">

                01:
                ${Number(
                  item.suara_calon_01 || 0
                )}

                |

                02:
                ${Number(
                  item.suara_calon_02 || 0
                )}

                |

                03:
                ${Number(
                  item.suara_calon_03 || 0
                )}

                <br>

                <span class="text-slate-500">

                  04:
                  ${Number(
                    item.suara_calon_04 || 0
                  )}

                  |

                  05:
                  ${Number(
                    item.suara_calon_05 || 0
                  )}

                  |

                  Tidak Sah:
                  ${Number(
                    item.suara_tidak_sah || 0
                  )}

                </span>

              </td>


              <!-- TOTAL -->

              <td
                class="p-3 text-center font-bold text-white">

                ${Number(
                  item.total_suara_masuk || 0
                )}

              </td>


              <!-- STATUS -->

              <td
                class="p-3 text-center">

                ${statusBadge(
                  item.status_verifikasi
                )}

              </td>


              <!-- FOTO -->

              <td
                class="p-3 text-center">

                ${photoLink}

              </td>


              <!-- AKSI -->

              <td
                class="p-3 text-center">

                ${aksi}

              </td>


            </tr>

          `;

        }
      );

    }


    /* ====================================================
       ACTION BUTTONS
    ==================================================== */

    function renderActionButtons(item) {

      const status =
        item.status_verifikasi ||
        'PENDING';


      /*
       * Jika masih menunggu audit,
       * tampilkan semua aksi yang relevan.
       */

      if (
        status ===
          'MEMERLUKAN VERIFIKASI ADMIN'

        ||

        status ===
          'PLANO TIDAK SESUAI'

        ||

        status ===
          'FOTO PLANO BELUM TERVERIFIKASI'

      ) {

        return `

          <div
            class="flex flex-col gap-2 min-w-[170px]">


            <!-- SAHKAN MANUAL -->

            <button

              onclick="adminVerify(
                '${item.id}',
                'SAHKAN_MANUAL'
              )"

              class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-2 rounded-lg text-xs font-bold">

              ✅ Sahkan Manual

            </button>


            <!-- SAHKAN PLANO -->

            <button

              onclick="adminVerify(
                '${item.id}',
                'SAHKAN_PLANO'
              )"

              class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-lg text-xs font-bold">

              📊 Sahkan Plano

            </button>


            <!-- UBAH DATA -->

            <button

              onclick="openEditModal(
                '${item.id}'
              )"

              class="bg-amber-600 hover:bg-amber-700 text-white px-3 py-2 rounded-lg text-xs font-bold">

              ✏️ Ubah Data

            </button>

          </div>

        `;

      }


      /*
       * Data yang sudah VERIFIED tetap
       * dapat dibuka kembali untuk audit.
       */

      if (
        status ===
          'VERIFIED_BY_ADMIN'

        ||

        status ===
          'AUTO VERIFIED'

        ||

        status ===
          'AUTO_VERIFIED'

        ||

        status ===
          'EDITED_BY_SAKSI'

      ) {

        return `

          <div
            class="flex flex-col gap-2 min-w-[170px]">


            <button

              onclick="openEditModal(
                '${item.id}'
              )"

              class="bg-amber-600 hover:bg-amber-700 text-white px-3 py-2 rounded-lg text-xs font-bold">

              ✏️ Ubah Data

            </button>


            <button

              onclick="adminVerify(
                '${item.id}',
                'RESET_VERIFIKASI'
              )"

              class="bg-slate-600 hover:bg-slate-500 text-white px-3 py-2 rounded-lg text-xs font-bold">

              🔄 Buka Audit Lagi

            </button>

          </div>

        `;

      }


      return `

        <button

          onclick="openEditModal(
            '${item.id}'
          )"

          class="bg-amber-600 hover:bg-amber-700 text-white px-3 py-2 rounded-lg text-xs font-bold">

          ✏️ Ubah Data

        </button>

      `;

    }


    /* ====================================================
       ADMIN VERIFY
    ==================================================== */

    async function adminVerify(
      id,
      action
    ) {


      const item =
        globalData.find(
          d =>
            String(d.id) ===
            String(id)
        );


      if (!item) {

        alert(
          'Data TPS tidak ditemukan.'
        );

        return;

      }


      let pesan = '';


      /* --------------------------------------------------
         SAHKAN MANUAL
      -------------------------------------------------- */

      if (
        action ===
        'SAHKAN_MANUAL'
      ) {

        pesan =

          `Sahkan HASIL INPUT MANUAL?\n\n` +

          `Desa: ${
            item.desa || '-'
          }\n` +

          `TPS: ${
            item.tps || '-'
          }\n\n` +

          `01: ${
            item.suara_calon_01 || 0
          }\n` +

          `02: ${
            item.suara_calon_02 || 0
          }\n` +

          `03: ${
            item.suara_calon_03 || 0
          }\n` +

          `04: ${
            item.suara_calon_04 || 0
          }\n` +

          `05: ${
            item.suara_calon_05 || 0
          }\n` +

          `Tidak Sah: ${
            item.suara_tidak_sah || 0
          }\n\n` +

          `Total: ${
            item.total_suara_masuk || 0
          }`;

      }


      /* --------------------------------------------------
         SAHKAN PLANO
      -------------------------------------------------- */

      else if (
        action ===
        'SAHKAN_PLANO'
      ) {

        pesan =

          `Sahkan HASIL PLANO/OCR?\n\n` +

          `PERHATIAN:\n` +

          `Angka livecount akan diganti dengan hasil OCR jika OCR memenuhi syarat.\n\n` +

          `Desa: ${
            item.desa || '-'
          }\n` +

          `TPS: ${
            item.tps || '-'
          }\n\n` +

          `Confidence OCR: ${
            item.ocr_confidence ?? '-'
          }\n\n` +

          `Lanjutkan?`;

      }


      /* --------------------------------------------------
         RESET
      -------------------------------------------------- */

      else if (
        action ===
        'RESET_VERIFIKASI'
      ) {

        pesan =

          `Buka kembali data ini untuk AUDIT?\n\n` +

          `Desa: ${
            item.desa || '-'
          }\n` +

          `TPS: ${
            item.tps || '-'
          }\n\n` +

          `Status akan dikembalikan menjadi:\n` +

          `MEMERLUKAN VERIFIKASI ADMIN`;

      }


      if (
        !confirm(pesan)
      ) {

        return;

      }


      try {

        const adminNama =
          localStorage.getItem(
            'adminNama'
          ) ||
          'Admin';


        const res =
          await fetch(
            '/api/admin-verifikasi',
            {

              method: 'POST',

              headers: {

                'Content-Type':
                  'application/json'

              },

              body:
                JSON.stringify({

                  id:
                    item.id,

                  action,

                  admin_nama:
                    adminNama

                })

            }
          );


        const result =
          await res.json();


        if (
          !res.ok ||
          !result.ok
        ) {

          throw new Error(

            result.error ||

            'Gagal melakukan verifikasi'

          );

        }


        alert(

          result.message ||

          'Berhasil'

        );


        await fetchAdminData();


      } catch (err) {

        console.error(
          'ADMIN VERIFY ERROR:',
          err
        );


        alert(
          `Gagal: ${
            err.message
          }`
        );

      }

    }


    /* ====================================================
       OPEN EDIT MODAL
    ==================================================== */

    function openEditModal(id) {

      const item =
        globalData.find(
          d =>
            String(d.id) ===
            String(id)
        );


      if (!item) {

        alert(
          'Data TPS tidak ditemukan.'
        );

        return;

      }


      editingId =
        item.id;


      document.getElementById(
        'editLocation'
      ).innerText =

        `${item.kecamatan || '-'} / ` +

        `${item.desa || '-'} / ` +

        `TPS ${item.tps || '-'}`;


      document.getElementById(
        'editCalon01'
      ).value =
        Number(
          item.suara_calon_01 || 0
        );


      document.getElementById(
        'editCalon02'
      ).value =
        Number(
          item.suara_calon_02 || 0
        );


      document.getElementById(
        'editCalon03'
      ).value =
        Number(
          item.suara_calon_03 || 0
        );


      document.getElementById(
        'editCalon04'
      ).value =
        Number(
          item.suara_calon_04 || 0
        );


      document.getElementById(
        'editCalon05'
      ).value =
        Number(
          item.suara_calon_05 || 0
        );


      document.getElementById(
        'editTidakSah'
      ).value =
        Number(
          item.suara_tidak_sah || 0
        );


      updateEditTotal();


      document.getElementById(
        'editModal'
      ).classList.remove(
        'hidden'
      );


      document.getElementById(
        'editModal'
      ).classList.add(
        'flex'
      );

    }


    /* ====================================================
       CLOSE EDIT MODAL
    ==================================================== */

    function closeEditModal() {

      editingId =
        null;


      const modal =
        document.getElementById(
          'editModal'
        );


      modal.classList.add(
        'hidden'
      );


      modal.classList.remove(
        'flex'
      );

    }


    /* ====================================================
       UPDATE TOTAL PREVIEW
    ==================================================== */

    function updateEditTotal() {

      const ids = [

        'editCalon01',

        'editCalon02',

        'editCalon03',

        'editCalon04',

        'editCalon05',

        'editTidakSah'

      ];


      let total = 0;


      ids.forEach(
        id => {

          const value =
            Number(
              document.getElementById(
                id
              ).value
            );


          if (
            Number.isFinite(value)
          ) {

            total +=
              Math.max(
                0,
                Math.floor(value)
              );

          }

        }
      );


      document.getElementById(
        'editTotal'
      ).innerText =
        total;

    }


    /* ====================================================
       INPUT TOTAL EVENTS
    ==================================================== */

    [

      'editCalon01',

      'editCalon02',

      'editCalon03',

      'editCalon04',

      'editCalon05',

      'editTidakSah'

    ].forEach(
      id => {

        document.addEventListener(
          'input',
          event => {

            if (
              event.target.id ===
              id
            ) {

              updateEditTotal();

            }

          }
        );

      }
    );


    /* ====================================================
       SUBMIT EDIT
    ==================================================== */

    async function submitEditData() {

      if (!editingId) {

        alert(
          'Data yang diedit tidak ditemukan.'
        );

        return;

      }


      const data = {

        suara_calon_01:
          Number(
            document.getElementById(
              'editCalon01'
            ).value || 0
          ),

        suara_calon_02:
          Number(
            document.getElementById(
              'editCalon02'
            ).value || 0
          ),

        suara_calon_03:
          Number(
            document.getElementById(
              'editCalon03'
            ).value || 0
          ),

        suara_calon_04:
          Number(
            document.getElementById(
              'editCalon04'
            ).value || 0
          ),

        suara_calon_05:
          Number(
            document.getElementById(
              'editCalon05'
            ).value || 0
          ),

        suara_tidak_sah:
          Number(
            document.getElementById(
              'editTidakSah'
            ).value || 0
          )

      };


      /*
       * Normalisasi sisi browser.
       */

      Object.keys(data)
        .forEach(
          key => {

            if (
              !Number.isFinite(
                data[key]
              ) ||
              data[key] < 0
            ) {

              data[key] = 0;

            }

            data[key] =
              Math.floor(
                data[key]
              );

          }
        );


      const totalPreview =
        Object.values(data)
          .reduce(
            (
              sum,
              value
            ) =>
              sum + value,
            0
          );


      const item =
        globalData.find(
          d =>
            String(d.id) ===
            String(editingId)
        );


      const pesan =

        `Simpan perubahan data?\n\n` +

        `Desa: ${
          item?.desa || '-'
        }\n` +

        `TPS: ${
          item?.tps || '-'
        }\n\n` +

        `01: ${
          data.suara_calon_01
        }\n` +

        `02: ${
          data.suara_calon_02
        }\n` +

        `03: ${
          data.suara_calon_03
        }\n` +

        `04: ${
          data.suara_calon_04
        }\n` +

        `05: ${
          data.suara_calon_05
        }\n` +

        `Tidak Sah: ${
          data.suara_tidak_sah
        }\n\n` +

        `Total: ${
          totalPreview
        }\n\n` +

        `Data akan disahkan oleh admin.`;


      if (
        !confirm(pesan)
      ) {

        return;

      }


      try {

        const adminNama =
          localStorage.getItem(
            'adminNama'
          ) ||
          'Admin';


        const res =
          await fetch(
            '/api/admin-verifikasi',
            {

              method: 'POST',

              headers: {

                'Content-Type':
                  'application/json'

              },

              body:
                JSON.stringify({

                  id:
                    editingId,

                  action:
                    'UBAH_DATA',

                  admin_nama:
                    adminNama,

                  data

                })

            }
          );


        const result =
          await res.json();


        if (
          !res.ok ||
          !result.ok
        ) {

          throw new Error(

            result.error ||

            'Gagal mengubah data'

          );

        }


        closeEditModal();


        alert(

          result.message ||

          'Data berhasil diubah.'

        );


        await fetchAdminData();


      } catch (err) {

        console.error(
          'UBAH DATA ERROR:',
          err
        );


        alert(
          `Gagal: ${
            err.message
          }`
        );

      }

    }


    /* ====================================================
       LOGOUT
    ==================================================== */

    function logoutAdmin() {

      localStorage.removeItem(
        "adminToken"
      );

      localStorage.removeItem(
        "adminNama"
      );


      window.location.href =
        "/login";

    }


    /* ====================================================
       CLOSE MODAL KLIK LUAR
    ==================================================== */

    document.getElementById(
      'editModal'
    ).addEventListener(
      'click',
      function(event) {

        if (
          event.target ===
          this
        ) {

          closeEditModal();

        }

      }
    );


  </script>


  <!-- =====================================================
       STYLE INPUT MODAL
  ====================================================== -->

  <style>

    .edit-input {

      width: 100%;

      padding: 10px 12px;

      background:
        rgb(15 23 42);

      border:
        1px solid
        rgb(51 65 85);

      border-radius:
        8px;

      color:
        white;

      outline:
        none;

    }


    .edit-input:focus {

      border-color:
        rgb(59 130 246);

      box-shadow:
        0 0 0 2px
        rgb(59 130 246 / 20%);

    }


    .edit-input::-webkit-inner-spin-button,
    .edit-input::-webkit-outer-spin-button {

      opacity:
        1;

    }

  </style>

</body>
</html>
