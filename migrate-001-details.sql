-- Solo per database creati prima di questa versione
ALTER TABLE transactions ADD COLUMN details TEXT NOT NULL DEFAULT '';
