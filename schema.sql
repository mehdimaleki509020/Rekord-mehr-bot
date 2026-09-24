-- Idempotent schema creation. Private target data is loaded via the authenticated admin endpoint.
CREATE TABLE IF NOT EXISTS targets (
  seller_key TEXT PRIMARY KEY, store_name TEXT NOT NULL, seller_name TEXT NOT NULL,
  baseline_m REAL NOT NULL, target20_m REAL NOT NULL, reward20_m REAL NOT NULL,
  target30_m REAL NOT NULL, reward30_m REAL NOT NULL, target40_m REAL NOT NULL, reward40_m REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS performance (
  seller_key TEXT PRIMARY KEY, sales_m REAL NOT NULL DEFAULT 0, max_day INTEGER NOT NULL DEFAULT 0,
  year INTEGER, month INTEGER, updated_at TEXT, source_upload_id INTEGER
);
CREATE TABLE IF NOT EXISTS user_links (
  user_id TEXT PRIMARY KEY, seller_key TEXT NOT NULL, bale_name TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT, file_id TEXT, file_unique_id TEXT, file_name TEXT,
  chat_id TEXT, message_id INTEGER, uploader_id TEXT, uploader_name TEXT,
  year INTEGER, month INTEGER, max_day INTEGER, matched_targets INTEGER,
  source_rows INTEGER, non_electric_rows INTEGER, total_sales_m REAL, created_at TEXT
);

CREATE TABLE IF NOT EXISTS import_receipts (receipt_key TEXT PRIMARY KEY, year INTEGER, month INTEGER, max_day INTEGER, source_time INTEGER, summary TEXT, notified INTEGER NOT NULL DEFAULT 0);
