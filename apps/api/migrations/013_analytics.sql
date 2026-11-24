-- Every time a guest's chosen frame produces a picture (so frame popularity can be reported, including tries the guest later replaced).
CREATE TABLE frame_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL, session_id uuid NOT NULL, frame_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, event_id) REFERENCES guest_sessions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (frame_id, event_id) REFERENCES frames(id, event_id) ON DELETE CASCADE
);
CREATE INDEX frame_selections_event_idx ON frame_selections(event_id, at);
CREATE INDEX frame_selections_frame_idx ON frame_selections(frame_id);
-- Earlier events: one selection per picture that still exists (tries that were replaced before this release cannot be recovered).
INSERT INTO frame_selections(event_id, session_id, frame_id, at)
  SELECT event_id, session_id, frame_id, created_at FROM final_compositions WHERE session_id IS NOT NULL;
-- Report queries by day and by actor.
CREATE INDEX share_events_comp_idx ON share_events(composition_id);
CREATE INDEX audit_logs_event_action_idx ON audit_logs(event_id, action, at);
