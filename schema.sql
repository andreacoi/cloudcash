CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  recovery_hash TEXT              -- SHA-256 del codice di recupero (vuoto = non impostato)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  remember INTEGER NOT NULL DEFAULT 1,   -- 1 = "Ricordami": 30 giorni, senza blocco per inattività
  last_seen INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES accounts(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  placeholder INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  code TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',            -- '#rrggbb' oppure vuoto (predefinito)
  tax_related INTEGER NOT NULL DEFAULT 0,
  opening_balance INTEGER NOT NULL DEFAULT 0, -- conto Patrimonio netto dei saldi di apertura
  limit_high INTEGER,                         -- centesimi, nel segno mostrato (come GnuCash)
  limit_low INTEGER,
  limit_subs INTEGER NOT NULL DEFAULT 0       -- il limite include i sottoconti
);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  date_posted TEXT NOT NULL,       -- YYYY-MM-DD
  date_entered TEXT NOT NULL,      -- ISO
  num TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT ''  -- HTML (editor rich text), non incluso nell'export .gnucash
);
CREATE TABLE IF NOT EXISTS splits (
  id TEXT PRIMARY KEY,
  tx_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  amount INTEGER NOT NULL,         -- centesimi EUR; >0 dare, <0 avere
  memo TEXT NOT NULL DEFAULT '',
  reconciled TEXT NOT NULL DEFAULT 'n'
);
CREATE INDEX IF NOT EXISTS idx_splits_tx ON splits(tx_id);
CREATE INDEX IF NOT EXISTS idx_splits_acc ON splits(account_id);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date_posted);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL   -- JSON
);
