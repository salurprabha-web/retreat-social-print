-- Multi-photo frames: each upload belongs to a frame slot; a composition records which upload filled which slot.
ALTER TABLE photo_uploads ADD COLUMN slot int NOT NULL DEFAULT 1 CHECK (slot BETWEEN 1 AND 8);
DROP INDEX photo_uploads_session_sha_uq;
CREATE UNIQUE INDEX photo_uploads_session_slot_sha_uq ON photo_uploads(session_id, slot, sha256) WHERE deleted_at IS NULL;

ALTER TABLE final_compositions ADD COLUMN session_id uuid;
ALTER TABLE final_compositions ADD COLUMN input_hash text;
ALTER TABLE final_compositions ADD COLUMN bytes bigint;
ALTER TABLE final_compositions ADD COLUMN mime text NOT NULL DEFAULT 'image/jpeg';
ALTER TABLE final_compositions ADD CONSTRAINT final_compositions_session_fk
  FOREIGN KEY (session_id, event_id) REFERENCES guest_sessions(id, event_id) ON DELETE CASCADE;
CREATE INDEX final_compositions_session_idx ON final_compositions(session_id);

CREATE TABLE composition_photos (
  composition_id uuid NOT NULL, event_id uuid NOT NULL, slot int NOT NULL, upload_id uuid NOT NULL, adjust jsonb NOT NULL,
  PRIMARY KEY (composition_id, slot),
  FOREIGN KEY (composition_id, event_id) REFERENCES final_compositions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (upload_id, event_id) REFERENCES photo_uploads(id, event_id) ON DELETE CASCADE
);
CREATE INDEX composition_photos_upload_idx ON composition_photos(upload_id);
