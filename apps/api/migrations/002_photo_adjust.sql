-- Non-destructive guest adjustments (rotate/zoom/pan) live beside the untouched original.
ALTER TABLE photo_uploads ADD COLUMN adjust jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE photo_uploads ADD COLUMN low_res boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX photo_uploads_session_sha_uq ON photo_uploads(session_id, sha256) WHERE deleted_at IS NULL;
CREATE INDEX photo_uploads_event_idx ON photo_uploads(event_id, created_at DESC);
