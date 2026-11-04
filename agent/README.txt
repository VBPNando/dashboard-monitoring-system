MONITORING AGENT - CPU, RAM & DISK ASLI SERVER DATABASE
=======================================================

Database (MariaDB / PostgreSQL) tidak menyediakan CPU & RAM server lewat SQL.
Agen kecil ini dijalankan DI SERVER DATABASE dan mengirim angka tersebut ke Dashboard Monitoring System.

Kebutuhan : Node.js 18+ di server database (https://nodejs.org). Tidak perlu npm install.
Port      : 9187 (TCP) harus bisa diakses dari komputer yang menjalankan Dashboard Monitoring System.

WINDOWS (mis. server XAMPP) - DISARANKAN
  1. Salin folder "agent" ini ke server database (mis. C:\monitoring-agent).
  2. Klik dua kali menu-agent.bat (otomatis meminta izin administrator).
  3. Pilih 1 "Pasang JALAN OTOMATIS":
       - agen berjalan di latar belakang (tanpa jendela) dan menyala sendiri setiap Windows hidup,
         walau belum ada yang login; bila berhenti, dinyalakan ulang otomatis
       - port 9187 dibuka di Windows Firewall
  4. Menu langsung menampilkan Agent URL & Token (bisa dilihat lagi lewat pilihan 5).
  Pilihan lain: 3 nyalakan ulang, 4 hentikan, 2 hapus jalan otomatis, 6 log (agent.log).

  Masih bisa menjalankan manual di jendela: start-agent.bat (atau menu T).
  Jangan jalankan start-agent.bat bila jalan otomatis sudah terpasang (bentrok port).

LINUX
  node dbmon-agent.mjs
  (buka port: sudo ufw allow 9187/tcp, atau firewall-cmd --add-port=9187/tcp --permanent)
  Jalan otomatis: buat service systemd yang menjalankan perintah di atas.

DI DASHBOARD
  Pada panel database -> menu ... -> "Atur agen CPU & RAM" -> isi Agent URL & Token.

KEAMANAN
  - Setiap permintaan wajib token (tersimpan di agent-token.txt; jangan dibagikan).
  - Batasi IP: buka run-agent.bat dengan Notepad, aktifkan baris
      set DBMON_AGENT_ALLOW=192.168.1.
    lalu menu-agent.bat -> 3 (nyalakan ulang).
  - Agen hanya MEMBACA angka CPU/RAM/disk; tidak bisa menjalankan perintah apa pun.
