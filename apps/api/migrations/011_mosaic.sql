-- One mosaic per event. Settings live in a validated JSON column; whether the module is ON stays in event_settings.mosaic_enabled.
ALTER TABLE mosaic_projects ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE mosaic_projects ADD COLUMN mosaic_token text NOT NULL DEFAULT encode(gen_random_bytes(12),'hex');
ALTER TABLE mosaic_projects ADD COLUMN master_width int;
ALTER TABLE mosaic_projects ADD COLUMN master_height int;
ALTER TABLE mosaic_projects ADD COLUMN cols int;
ALTER TABLE mosaic_projects ADD COLUMN rows int;
ALTER TABLE mosaic_projects ADD COLUMN cell_colors text;            -- average colour of every cell of the master, 6 hex digits each
ALTER TABLE mosaic_projects ADD COLUMN grid_version int NOT NULL DEFAULT 0;
ALTER TABLE mosaic_projects ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX mosaic_projects_event_uq ON mosaic_projects(event_id);
CREATE UNIQUE INDEX mosaic_projects_token_uq ON mosaic_projects(mosaic_token);
ALTER TABLE mosaic_projects ADD CONSTRAINT mosaic_projects_id_event_uq UNIQUE (id, event_id);

-- Which picture sits in which cell. A picture keeps its cell until it is removed (deleted, rejected, hidden, opted out) or the grid is rebuilt.
CREATE TABLE mosaic_tiles (
  composition_id uuid PRIMARY KEY,
  event_id uuid NOT NULL,
  mosaic_id uuid NOT NULL,
  cell int NOT NULL CHECK (cell >= 0),
  color char(6) NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mosaic_id, cell),
  FOREIGN KEY (composition_id, event_id) REFERENCES final_compositions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (mosaic_id, event_id) REFERENCES mosaic_projects(id, event_id) ON DELETE CASCADE
);
CREATE INDEX mosaic_tiles_event_idx ON mosaic_tiles(event_id);
