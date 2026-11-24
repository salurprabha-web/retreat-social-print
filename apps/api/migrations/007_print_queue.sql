-- A picture only enters the print queue when the guest finishes (not while still editing).
ALTER TABLE final_compositions ADD COLUMN finalized_at timestamptz;
CREATE INDEX final_compositions_final_idx ON final_compositions(event_id, finalized_at DESC) WHERE deleted_at IS NULL AND finalized_at IS NOT NULL;

ALTER TABLE print_jobs ADD COLUMN kind text NOT NULL DEFAULT 'print' CHECK (kind IN ('print','reprint'));
ALTER TABLE print_jobs ADD COLUMN approved_at timestamptz;
ALTER TABLE print_jobs ADD COLUMN started_at timestamptz;
ALTER TABLE print_jobs ADD COLUMN finished_at timestamptz;
ALTER TABLE print_jobs ADD COLUMN requested_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE print_jobs ADD COLUMN note text;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_id_event_uq UNIQUE (id, event_id);
CREATE INDEX print_jobs_event_status_idx ON print_jobs(event_id, status, created_at);
CREATE INDEX print_jobs_composition_idx ON print_jobs(composition_id);

-- Every status change, who made it and when: the print history and operator activity.
CREATE TABLE print_job_events (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL, job_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  from_status text, to_status text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  note text,
  FOREIGN KEY (job_id, event_id) REFERENCES print_jobs(id, event_id) ON DELETE CASCADE
);
CREATE INDEX print_job_events_event_idx ON print_job_events(event_id, at DESC);
CREATE INDEX print_job_events_job_idx ON print_job_events(job_id, at);

ALTER TABLE event_settings ADD COLUMN print_paused boolean NOT NULL DEFAULT false;
