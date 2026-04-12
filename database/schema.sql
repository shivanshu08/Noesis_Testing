-- ============================================================
-- Noesis Testing Platform - PostgreSQL Database Schema
-- ============================================================

-- Run: psql -U postgres -f schema.sql
-- Or: CREATE DATABASE noesis_testing; \c noesis_testing; \i schema.sql

-- Custom ENUM types
DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('admin', 'tester', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE run_type AS ENUM ('single', 'suite', 'custom');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE run_status AS ENUM ('queued', 'running', 'passed', 'failed', 'error', 'stopped');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE result_status AS ENUM ('queued', 'running', 'passed', 'failed', 'error', 'skipped');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE log_level AS ENUM ('INFO', 'WARN', 'ERROR', 'DEBUG');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- Users & Authentication
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    role user_role NOT NULL DEFAULT 'tester',
    avatar_url VARCHAR(255) DEFAULT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_login TIMESTAMP DEFAULT NULL,
    run_count INT NOT NULL DEFAULT 0,
    suites_created INT NOT NULL DEFAULT 0,
    scripts_registered INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Script Categories
-- ============================================================
CREATE TABLE IF NOT EXISTS script_categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT DEFAULT NULL,
    icon VARCHAR(50) DEFAULT 'pi-folder',
    color VARCHAR(20) DEFAULT '#6366f1',
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- ST Scripts Registry
-- ============================================================
CREATE TABLE IF NOT EXISTS scripts (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    class_name VARCHAR(300) NOT NULL UNIQUE,
    method_name VARCHAR(200) DEFAULT NULL,
    category_id INT NOT NULL REFERENCES script_categories(id) ON DELETE RESTRICT,
    description TEXT DEFAULT NULL,
    file_path VARCHAR(500) NOT NULL,
    config_file VARCHAR(200) DEFAULT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    tags JSONB DEFAULT NULL,
    created_by INT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scripts_category ON scripts(category_id);
CREATE INDEX IF NOT EXISTS idx_scripts_class_name ON scripts(class_name);
CREATE INDEX IF NOT EXISTS idx_scripts_active ON scripts(is_active);

DROP TRIGGER IF EXISTS update_scripts_updated_at ON scripts;
CREATE TRIGGER update_scripts_updated_at BEFORE UPDATE ON scripts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Test Suites (grouping of scripts)
-- ============================================================
CREATE TABLE IF NOT EXISTS test_suites (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL UNIQUE,
    description TEXT DEFAULT NULL,
    config_xml TEXT DEFAULT NULL,
    is_parallel BOOLEAN NOT NULL DEFAULT FALSE,
    thread_count INT NOT NULL DEFAULT 1,
    tags JSONB DEFAULT NULL,
    created_by INT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS update_test_suites_updated_at ON test_suites;
CREATE TRIGGER update_test_suites_updated_at BEFORE UPDATE ON test_suites
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Suite-Script mapping (many-to-many)
-- ============================================================
CREATE TABLE IF NOT EXISTS suite_scripts (
    id SERIAL PRIMARY KEY,
    suite_id INT NOT NULL REFERENCES test_suites(id) ON DELETE CASCADE,
    script_id INT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
    execution_order INT NOT NULL DEFAULT 0,
    UNIQUE (suite_id, script_id)
);

-- ============================================================
-- Execution Runs
-- ============================================================
CREATE TABLE IF NOT EXISTS execution_runs (
    id SERIAL PRIMARY KEY,
    run_name VARCHAR(200) NOT NULL,
    run_type run_type NOT NULL DEFAULT 'single',
    suite_id INT DEFAULT NULL REFERENCES test_suites(id) ON DELETE SET NULL,
    status run_status NOT NULL DEFAULT 'queued',
    total_scripts INT NOT NULL DEFAULT 0,
    passed_count INT NOT NULL DEFAULT 0,
    failed_count INT NOT NULL DEFAULT 0,
    error_count INT NOT NULL DEFAULT 0,
    skipped_count INT NOT NULL DEFAULT 0,
    duration_ms BIGINT DEFAULT NULL,
    environment VARCHAR(50) DEFAULT 'local',
    config_xml TEXT DEFAULT NULL,
    triggered_by INT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    started_at TIMESTAMP DEFAULT NULL,
    completed_at TIMESTAMP DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_runs_status ON execution_runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_triggered_by ON execution_runs(triggered_by);
CREATE INDEX IF NOT EXISTS idx_runs_created_at ON execution_runs(created_at);

-- ============================================================
-- Execution Results (per-script result in a run)
-- ============================================================
CREATE TABLE IF NOT EXISTS execution_results (
    id SERIAL PRIMARY KEY,
    run_id INT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
    script_id INT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
    status result_status NOT NULL DEFAULT 'queued',
    duration_ms BIGINT DEFAULT NULL,
    error_message TEXT DEFAULT NULL,
    stack_trace TEXT DEFAULT NULL,
    screenshot_path VARCHAR(500) DEFAULT NULL,
    log_output TEXT DEFAULT NULL,
    started_at TIMESTAMP DEFAULT NULL,
    completed_at TIMESTAMP DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_results_run_id ON execution_results(run_id);
CREATE INDEX IF NOT EXISTS idx_results_script_status ON execution_results(script_id, status);

-- ============================================================
-- Execution Logs (real-time log streaming)
-- ============================================================
CREATE TABLE IF NOT EXISTS execution_logs (
    id BIGSERIAL PRIMARY KEY,
    run_id INT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
    result_id INT DEFAULT NULL REFERENCES execution_results(id) ON DELETE CASCADE,
    log_level log_level NOT NULL DEFAULT 'INFO',
    message TEXT NOT NULL,
    detailed_description TEXT DEFAULT NULL,
    source_component VARCHAR(120) DEFAULT NULL,
    log_context JSONB DEFAULT NULL,
    timestamp TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_logs_run_timestamp ON execution_logs(run_id, timestamp);

-- ============================================================
-- Centralized Application Logs (API + System + Audit)
-- ============================================================
CREATE TABLE IF NOT EXISTS app_logs (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    action VARCHAR(120) NOT NULL,
    module VARCHAR(120) NOT NULL,
    severity VARCHAR(10) NOT NULL DEFAULT 'INFO',
    status VARCHAR(40) NOT NULL DEFAULT 'SUCCESS',
    user_id INT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    username VARCHAR(120) DEFAULT NULL,
    message TEXT NOT NULL,
    request_id VARCHAR(120) DEFAULT NULL,
    http_method VARCHAR(10) DEFAULT NULL,
    http_path VARCHAR(600) DEFAULT NULL,
    http_status INT DEFAULT NULL,
    duration_ms INT DEFAULT NULL,
    metadata JSONB DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_logs_timestamp ON app_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_app_logs_severity_timestamp ON app_logs(severity, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_app_logs_module_timestamp ON app_logs(module, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_app_logs_action_timestamp ON app_logs(action, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_app_logs_user_timestamp ON app_logs(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_app_logs_http_status_timestamp ON app_logs(http_status, timestamp DESC);

-- ============================================================
-- Scheduled Runs
-- ============================================================
CREATE TABLE IF NOT EXISTS scheduled_runs (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    suite_id INT DEFAULT NULL REFERENCES test_suites(id) ON DELETE CASCADE,
    script_ids JSONB DEFAULT NULL,
    description TEXT DEFAULT NULL,
    cron_expression VARCHAR(100) NOT NULL,
    is_one_time BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    environment VARCHAR(50) DEFAULT 'local',
    last_run_at TIMESTAMP DEFAULT NULL,
    next_run_at TIMESTAMP DEFAULT NULL,
    created_by INT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT check_suite_or_scripts CHECK (suite_id IS NOT NULL OR script_ids IS NOT NULL)
);

-- Migration for existing tables (safe to re-run)
DO $$ BEGIN
    ALTER TABLE scheduled_runs ALTER COLUMN suite_id DROP NOT NULL;
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$ BEGIN
    ALTER TABLE scheduled_runs ADD COLUMN script_ids JSONB DEFAULT NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
    ALTER TABLE scheduled_runs ADD COLUMN description TEXT DEFAULT NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ============================================================
-- Seed Data
-- ============================================================

-- Default admin user (password: admin123 - bcrypt hashed)
INSERT INTO users (username, email, password_hash, full_name, role) 
SELECT 'admin', 'admin@noesis.com', '$2b$12$LJ3m4ys4Fp/hMN2K3EXAMPLE_HASH_REPLACE_ON_SETUP', 'System Admin', 'admin'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'admin');

-- Script Categories
INSERT INTO script_categories (name, description, icon, color, sort_order) 
SELECT * FROM (VALUES
  ('Configuration', 'Configuration screen test scripts', 'pi-cog', '#6366f1', 1),
  ('Feature', 'Feature-based test scripts', 'pi-star', '#f59e0b', 2),
  ('Manual', 'Manual screen E2E test scripts', 'pi-file-edit', '#10b981', 3),
  ('Sanity', 'Sanity and smoke test scripts', 'pi-check-circle', '#ef4444', 4),
  ('API', 'API integration test scripts', 'pi-server', '#8b5cf6', 5),
  ('Dashboard', 'Dashboard and UI test scripts', 'pi-chart-bar', '#06b6d4', 6),
  ('Security', 'Access and security test scripts', 'pi-shield', '#f97316', 7),
  ('Intake', 'Intake and processing test scripts', 'pi-inbox', '#ec4899', 8)
) AS t(name, description, icon, color, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM script_categories sc WHERE sc.name = t.name);

-- Register all discovered ST Scripts (inserted via init script)
-- (See backend/src/database/init.ts for seed data)

-- Default Test Suites
INSERT INTO test_suites (name, description, created_by) 
SELECT * FROM (VALUES
  ('Full Regression Suite', 'Complete regression suite with Configuration, Manual, and Feature tests', 1),
  ('Sanity Suite', 'Quick sanity checks for build verification', 1),
  ('Configuration Suite', 'All configuration screen tests', 1)
) AS t(name, description, created_by)
WHERE NOT EXISTS (SELECT 1 FROM test_suites ts WHERE ts.name = t.name);
