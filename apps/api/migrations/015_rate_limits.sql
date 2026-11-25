-- Shared request counters for the strict rate limits (sign-in, guest uploads, compose, print agents, sync).
-- On a serverless host every request may run in a different instance, so counters kept in memory would not add up; these live in the database.
CREATE TABLE rate_limits (
  key          text PRIMARY KEY,                 -- "<address>|<method>|<route>"
  count        integer     NOT NULL,
  window_start timestamptz NOT NULL
);
CREATE INDEX rate_limits_window_idx ON rate_limits(window_start);
