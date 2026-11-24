-- Who moderated a picture, when, and why (the audit log keeps the full history).
ALTER TABLE final_compositions ADD COLUMN moderated_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE final_compositions ADD COLUMN moderated_at timestamptz;
ALTER TABLE final_compositions ADD COLUMN moderation_note text;
CREATE INDEX final_compositions_mod_idx ON final_compositions(event_id, moderation, created_at DESC) WHERE deleted_at IS NULL;
