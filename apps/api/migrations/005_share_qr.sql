-- Sharing configuration per event (labels, instructions, sponsor hashtags, which buttons to show).
ALTER TABLE event_settings ADD COLUMN share jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Who tapped share (for unique-sharer analytics); still only ever an attempt.
ALTER TABLE share_events ADD COLUMN session_id uuid;
CREATE INDEX share_events_event_idx ON share_events(event_id, created_at);

-- QR codes: several per event, custom landing, kiosk label, scan history.
ALTER TABLE qr_tracking ADD COLUMN landing_url text;
ALTER TABLE qr_tracking ADD COLUMN kiosk_label text;
ALTER TABLE qr_tracking ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE qr_tracking ADD CONSTRAINT qr_tracking_id_event_uq UNIQUE (id, event_id);
CREATE INDEX qr_tracking_event_idx ON qr_tracking(event_id, created_at);

CREATE TABLE qr_scan_events (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL, qr_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (qr_id, event_id) REFERENCES qr_tracking(id, event_id) ON DELETE CASCADE
);
CREATE INDEX qr_scan_events_event_idx ON qr_scan_events(event_id, at);
CREATE INDEX qr_scan_events_qr_idx ON qr_scan_events(qr_id, at);
