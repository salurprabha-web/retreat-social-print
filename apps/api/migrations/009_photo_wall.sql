-- The wall is shown on a TV with nobody logged in, so it gets its own unguessable link (revocable by making a new one).
ALTER TABLE photo_wall_settings ADD COLUMN wall_token text NOT NULL DEFAULT encode(gen_random_bytes(12),'hex');
CREATE UNIQUE INDEX photo_wall_token_uq ON photo_wall_settings(wall_token);

-- A guest can keep their picture off the big screen.
ALTER TABLE guest_sessions ADD COLUMN wall_opt_out boolean NOT NULL DEFAULT false;

-- How often each picture was actually shown on the wall (report: "photo wall appearances").
CREATE TABLE wall_views (
  composition_id uuid PRIMARY KEY,
  event_id uuid NOT NULL,
  shown_count int NOT NULL DEFAULT 0,
  first_shown_at timestamptz NOT NULL DEFAULT now(),
  last_shown_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (composition_id, event_id) REFERENCES final_compositions(id, event_id) ON DELETE CASCADE
);
CREATE INDEX wall_views_event_idx ON wall_views(event_id);
