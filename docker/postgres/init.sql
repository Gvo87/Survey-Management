-- Runs once, when the Postgres volume is first created (local development only).
-- In production these roles are created by infrastructure code, with real passwords.

-- The API and worker connect as this role. It is NOT a superuser and has no BYPASSRLS,
-- so row-level security applies to every query it makes.
CREATE ROLE survey_app LOGIN PASSWORD 'survey_app';

-- Separate database for integration tests.
CREATE DATABASE survey_test OWNER survey;
