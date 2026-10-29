CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, uri TEXT NOT NULL UNIQUE, author_handle TEXT NOT NULL, author_name TEXT, text TEXT NOT NULL, url TEXT, created_at TEXT, detected_at TEXT NOT NULL, intent TEXT NOT NULL, score INTEGER NOT NULL, category TEXT, reasons TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0, is_saved INTEGER NOT NULL DEFAULT 0, notified INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_posts_detected ON posts(detected_at);
CREATE INDEX IF NOT EXISTS idx_posts_intent_score ON posts(intent, score);
CREATE INDEX IF NOT EXISTS idx_posts_read ON posts(is_read);
CREATE TABLE IF NOT EXISTS scan_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, queries_run INTEGER NOT NULL DEFAULT 0, posts_seen INTEGER NOT NULL DEFAULT 0, new_matches INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
