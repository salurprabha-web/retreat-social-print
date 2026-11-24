-- Sponsors become a managed list per event (logo, link, hashtag, where the logo is shown).
ALTER TABLE sponsors ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE sponsors ADD COLUMN position int NOT NULL DEFAULT 0;
ALTER TABLE sponsors ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sponsors ADD CONSTRAINT sponsors_name_len CHECK (char_length(name) BETWEEN 1 AND 80);
CREATE INDEX sponsors_event_idx ON sponsors(event_id, position, created_at);
