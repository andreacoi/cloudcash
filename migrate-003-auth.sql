-- Solo per database creati prima di questa versione (Ricordami, blocco per inattività, codice di recupero)
ALTER TABLE users ADD COLUMN recovery_hash TEXT;
ALTER TABLE sessions ADD COLUMN remember INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0;
