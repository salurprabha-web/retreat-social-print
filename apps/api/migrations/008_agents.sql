-- Print agents (Windows app) and their printers.
ALTER TABLE devices ADD COLUMN pairing_hash text;              -- SHA-256 of a one-time pairing code (never the code itself)
ALTER TABLE devices ADD COLUMN pairing_expires_at timestamptz;
ALTER TABLE devices ADD COLUMN paired_at timestamptz;
ALTER TABLE devices ADD COLUMN version text;
ALTER TABLE devices ADD COLUMN host_name text;
ALTER TABLE devices ADD COLUMN last_ip text;
CREATE UNIQUE INDEX devices_pairing_uq ON devices(pairing_hash) WHERE pairing_hash IS NOT NULL;
CREATE INDEX devices_event_idx ON devices(event_id, kind);

-- A printer the agent reported. It does NOT print anything until an admin enables it and says what paper it holds.
ALTER TABLE printers ADD COLUMN enabled boolean NOT NULL DEFAULT false;
ALTER TABLE printers ADD COLUMN driver_papers jsonb NOT NULL DEFAULT '[]'::jsonb;    -- paper sizes the Windows driver offers
ALTER TABLE printers ADD COLUMN detail text;                                          -- e.g. "Paper out"
UPDATE printers SET paper_size = COALESCE(paper_size, 'any'), orientation = COALESCE(orientation, 'auto');
ALTER TABLE printers ALTER COLUMN paper_size SET DEFAULT 'any';
ALTER TABLE printers ALTER COLUMN orientation SET DEFAULT 'auto';
CREATE UNIQUE INDEX printers_device_name_uq ON printers(device_id, windows_name) WHERE device_id IS NOT NULL;
CREATE INDEX printers_event_idx ON printers(event_id);
