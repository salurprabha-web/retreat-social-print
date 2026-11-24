-- Retention: guest data is deleted a set number of days after an event is archived; the event keeps anonymous statistics.
ALTER TABLE events ADD COLUMN purged_at timestamptz;
ALTER TABLE events ADD COLUMN retention_snapshot jsonb;          -- the event's report figures, frozen just before its guest data was deleted
ALTER TABLE events ADD COLUMN retention_hold boolean NOT NULL DEFAULT false;     -- legal hold: never purge automatically
CREATE INDEX events_retention_idx ON events(archived_at) WHERE status='archived' AND purged_at IS NULL;

-- Staff accounts: when someone last signed in and when their password last changed.
ALTER TABLE users ADD COLUMN last_login_at timestamptz;
ALTER TABLE users ADD COLUMN password_changed_at timestamptz;
