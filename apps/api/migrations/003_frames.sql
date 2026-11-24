ALTER TABLE frames ADD COLUMN orientation text NOT NULL DEFAULT 'portrait' CHECK (orientation IN ('portrait','landscape'));
ALTER TABLE frames ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE frames ADD COLUMN created_by uuid REFERENCES users(id);
CREATE INDEX frames_event_idx ON frames(event_id, created_at);
CREATE INDEX frame_layers_frame_idx ON frame_layers(frame_id, z_index);
