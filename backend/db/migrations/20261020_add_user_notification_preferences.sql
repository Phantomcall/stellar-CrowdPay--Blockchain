-- Migration: 20261020_add_user_notification_preferences.sql
-- Persist a user's notification preferences server-side so the Profile page
-- toggles actually govern delivery instead of only writing to localStorage.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS notification_preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
