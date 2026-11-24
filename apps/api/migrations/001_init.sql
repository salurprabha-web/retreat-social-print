-- RETREAT SOCIAL PRINT: initial schema. Every event-owned table carries event_id and is linked to its parents through
-- COMPOSITE foreign keys (id, event_id) so a row can never point at another event's data.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE roles (name text PRIMARY KEY);
INSERT INTO roles(name) VALUES ('super_admin'),('event_manager'),('print_operator'),('reporting_viewer');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL, name text NOT NULL,
  password_hash text NOT NULL,
  global_role text NOT NULL REFERENCES roles(name),
  active boolean NOT NULL DEFAULT true,
  failed_logins int NOT NULL DEFAULT 0, locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, slug text NOT NULL,
  guest_token text NOT NULL DEFAULT encode(gen_random_bytes(12),'hex'),
  client_name text, hashtag text, event_date date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','inactive','archived')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (slug), UNIQUE (guest_token)
);

CREATE TABLE user_event_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  role text NOT NULL REFERENCES roles(name) CHECK (role <> 'super_admin'),
  PRIMARY KEY (user_id, event_id)
);

CREATE TABLE event_settings (
  event_id uuid PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  print_mode text NOT NULL DEFAULT 'manual' CHECK (print_mode IN ('auto','manual','batch')),
  default_copies int NOT NULL DEFAULT 1 CHECK (default_copies BETWEEN 1 AND 10),
  max_upload_mb int NOT NULL DEFAULT 25 CHECK (max_upload_mb BETWEEN 1 AND 100),
  retention_days int NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 3650),
  require_consent boolean NOT NULL DEFAULT true,
  photo_wall_enabled boolean NOT NULL DEFAULT false,
  mosaic_enabled boolean NOT NULL DEFAULT false,
  branding jsonb NOT NULL DEFAULT '{}'::jsonb,
  instagram_handle text, suggested_caption text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE guest_experience_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES events(id) ON DELETE CASCADE,
  name text NOT NULL, category text, definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE guest_experience_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  version int NOT NULL, state text NOT NULL CHECK (state IN ('draft','published','superseded')),
  definition jsonb NOT NULL, note text,
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (event_id, version), UNIQUE (id, event_id)
);
CREATE UNIQUE INDEX gep_one_published ON guest_experience_pages(event_id) WHERE state='published';
CREATE UNIQUE INDEX gep_one_draft ON guest_experience_pages(event_id) WHERE state='draft';

CREATE TABLE page_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL, page_id uuid NOT NULL,
  type text NOT NULL, position int NOT NULL DEFAULT 0, props jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (page_id, event_id) REFERENCES guest_experience_pages(id, event_id) ON DELETE CASCADE
);

CREATE TABLE sponsors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name text NOT NULL, url text, hashtag text, logo_asset text, placement jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (id, event_id)
);

CREATE TABLE frames (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name text NOT NULL, output_format text NOT NULL DEFAULT '4x6',
  width_px int NOT NULL CHECK (width_px > 0), height_px int NOT NULL CHECK (height_px > 0),
  dpi int NOT NULL DEFAULT 300, placeholders jsonb NOT NULL DEFAULT '[]'::jsonb,
  sponsor_id uuid, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, event_id),
  FOREIGN KEY (sponsor_id, event_id) REFERENCES sponsors(id, event_id) ON DELETE SET NULL (sponsor_id)
);

CREATE TABLE frame_layers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL, frame_id uuid NOT NULL,
  type text NOT NULL, z_index int NOT NULL DEFAULT 0, props jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (frame_id, event_id) REFERENCES frames(id, event_id) ON DELETE CASCADE
);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('kiosk','print_agent','display')),
  name text NOT NULL, token_hash text NOT NULL UNIQUE,
  last_seen_at timestamptz, enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE printers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  name text NOT NULL, windows_name text, paper_size text, orientation text,
  status text NOT NULL DEFAULT 'unknown', last_seen_at timestamptz,
  UNIQUE (id, event_id)
);

CREATE TABLE guest_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_code text NOT NULL, device_id uuid REFERENCES devices(id),
  consent_at timestamptz, fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, event_id), UNIQUE (event_id, guest_code)
);

CREATE TABLE photo_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL, session_id uuid NOT NULL,
  storage_key text NOT NULL UNIQUE, mime text NOT NULL, bytes bigint NOT NULL, width int, height int, sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (id, event_id),
  FOREIGN KEY (session_id, event_id) REFERENCES guest_sessions(id, event_id) ON DELETE CASCADE
);

CREATE TABLE final_compositions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL, upload_id uuid NOT NULL, frame_id uuid NOT NULL,
  storage_key text NOT NULL UNIQUE, width_px int NOT NULL, height_px int NOT NULL, sha256 text NOT NULL,
  moderation text NOT NULL DEFAULT 'pending' CHECK (moderation IN ('pending','approved','rejected')),
  show_on_wall boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (id, event_id),
  FOREIGN KEY (upload_id, event_id) REFERENCES photo_uploads(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (frame_id, event_id) REFERENCES frames(id, event_id) ON DELETE CASCADE
);
CREATE INDEX final_compositions_event_idx ON final_compositions(event_id, created_at DESC);

CREATE TABLE share_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL, composition_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('instagram','whatsapp','native','download','copy_caption','copy_hashtag')),
  outcome text NOT NULL DEFAULT 'attempted' CHECK (outcome IN ('attempted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (composition_id, event_id) REFERENCES final_compositions(id, event_id) ON DELETE CASCADE
);

CREATE TABLE print_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL, composition_id uuid NOT NULL, printer_id uuid,
  status text NOT NULL DEFAULT 'received' CHECK (status IN
    ('received','pending','approved','printing','printed','failed','cancelled','reprint_requested')),
  copies int NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 50),
  attempt int NOT NULL DEFAULT 0, error text,
  idempotency_key text NOT NULL,
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, idempotency_key),
  FOREIGN KEY (composition_id, event_id) REFERENCES final_compositions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (printer_id, event_id) REFERENCES printers(id, event_id) ON DELETE SET NULL (printer_id)
);
CREATE INDEX print_jobs_queue_idx ON print_jobs(event_id, created_at) WHERE status IN ('pending','approved','printing');

CREATE TABLE qr_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE, label text, device_id uuid REFERENCES devices(id),
  enabled boolean NOT NULL DEFAULT true, expires_at timestamptz, style jsonb NOT NULL DEFAULT '{}'::jsonb,
  scans int NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE photo_wall_settings (
  event_id uuid PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  moderation_required boolean NOT NULL DEFAULT true, display_seconds int NOT NULL DEFAULT 6,
  mode text NOT NULL DEFAULT 'slideshow' CHECK (mode IN ('slideshow','grid','latest','random')),
  style jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE mosaic_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  master_storage_key text, tile_count int NOT NULL DEFAULT 1000, status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL, entity text, entity_id text, detail jsonb NOT NULL DEFAULT '{}'::jsonb, ip text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_event_idx ON audit_logs(event_id, at DESC);
