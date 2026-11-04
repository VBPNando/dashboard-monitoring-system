-- Mengaktifkan pg_stat_statements agar dashboard menampilkan QPS asli (bukan TPS)
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
