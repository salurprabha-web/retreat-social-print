-- Offline (local server) mode.
-- CLOUD side: credentials that let one local event server push one event's data.
CREATE TABLE sync_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name text NOT NULL, token_hash text NOT NULL UNIQUE,       -- only a hash of the token is kept
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz, last_ip text, revoked_at timestamptz,
  UNIQUE (id, event_id)
);
CREATE INDEX sync_credentials_event_idx ON sync_credentials(event_id);

-- LOCAL side: what has already been delivered (hash of the row as it was sent), so only changes are sent again.
CREATE TABLE sync_state (
  event_id uuid NOT NULL, entity text NOT NULL, row_key text NOT NULL, hash text NOT NULL, synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, entity, row_key)
);
CREATE TABLE sync_meta (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());

-- A print job delivered from a local server is a read-only record on the cloud: it must never be claimed or printed again from here.
ALTER TABLE print_jobs ADD COLUMN synced_from uuid;
-- Numbered history rows from a local server get their own number here; the origin makes a retried delivery harmless.
ALTER TABLE print_job_events ADD COLUMN origin_key text;
CREATE UNIQUE INDEX print_job_events_origin_uq ON print_job_events(origin_key) WHERE origin_key IS NOT NULL;
ALTER TABLE qr_scan_events ADD COLUMN origin_key text;
CREATE UNIQUE INDEX qr_scan_events_origin_uq ON qr_scan_events(origin_key) WHERE origin_key IS NOT NULL;
