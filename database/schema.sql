-- ============================================================
-- Noesis Testing Platform - MySQL Database Schema
-- ============================================================

CREATE DATABASE IF NOT EXISTS noesis_testing;
USE noesis_testing;

-- ============================================================
-- Users & Authentication
-- ============================================================
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    role ENUM('admin', 'tester', 'viewer') NOT NULL DEFAULT 'tester',
    avatar_url VARCHAR(255) DEFAULT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_login DATETIME DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_username (username),
    INDEX idx_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- Script Categories
-- ============================================================
CREATE TABLE script_categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT DEFAULT NULL,
    icon VARCHAR(50) DEFAULT 'pi-folder',
    color VARCHAR(20) DEFAULT '#6366f1',
    sort_order INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- ST Scripts Registry
-- ============================================================
CREATE TABLE scripts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    class_name VARCHAR(300) NOT NULL UNIQUE,
    method_name VARCHAR(200) DEFAULT NULL,
    category_id INT NOT NULL,
    description TEXT DEFAULT NULL,
    file_path VARCHAR(500) NOT NULL,
    config_file VARCHAR(200) DEFAULT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    tags JSON DEFAULT NULL,
    created_by INT DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES script_categories(id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_category (category_id),
    INDEX idx_class_name (class_name),
    INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- Test Suites (grouping of scripts)
-- ============================================================
CREATE TABLE test_suites (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    description TEXT DEFAULT NULL,
    config_xml TEXT DEFAULT NULL,
    is_parallel BOOLEAN NOT NULL DEFAULT FALSE,
    thread_count INT NOT NULL DEFAULT 1,
    created_by INT DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- Suite-Script mapping (many-to-many)
-- ============================================================
CREATE TABLE suite_scripts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    suite_id INT NOT NULL,
    script_id INT NOT NULL,
    execution_order INT NOT NULL DEFAULT 0,
    FOREIGN KEY (suite_id) REFERENCES test_suites(id) ON DELETE CASCADE,
    FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE CASCADE,
    UNIQUE KEY uk_suite_script (suite_id, script_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- Execution Runs
-- ============================================================
CREATE TABLE execution_runs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    run_name VARCHAR(200) NOT NULL,
    run_type ENUM('single', 'suite', 'custom') NOT NULL DEFAULT 'single',
    suite_id INT DEFAULT NULL,
    status ENUM('queued', 'running', 'passed', 'failed', 'error', 'stopped') NOT NULL DEFAULT 'queued',
    total_scripts INT NOT NULL DEFAULT 0,
    passed_count INT NOT NULL DEFAULT 0,
    failed_count INT NOT NULL DEFAULT 0,
    error_count INT NOT NULL DEFAULT 0,
    skipped_count INT NOT NULL DEFAULT 0,
    duration_ms BIGINT DEFAULT NULL,
    environment VARCHAR(50) DEFAULT 'local',
    config_xml TEXT DEFAULT NULL,
    triggered_by INT DEFAULT NULL,
    started_at DATETIME DEFAULT NULL,
    completed_at DATETIME DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (suite_id) REFERENCES test_suites(id) ON DELETE SET NULL,
    FOREIGN KEY (triggered_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_status (status),
    INDEX idx_triggered_by (triggered_by),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- Execution Results (per-script result in a run)
-- ============================================================
CREATE TABLE execution_results (
    id INT AUTO_INCREMENT PRIMARY KEY,
    run_id INT NOT NULL,
    script_id INT NOT NULL,
    status ENUM('queued', 'running', 'passed', 'failed', 'error', 'skipped') NOT NULL DEFAULT 'queued',
    duration_ms BIGINT DEFAULT NULL,
    error_message TEXT DEFAULT NULL,
    stack_trace TEXT DEFAULT NULL,
    screenshot_path VARCHAR(500) DEFAULT NULL,
    log_output LONGTEXT DEFAULT NULL,
    started_at DATETIME DEFAULT NULL,
    completed_at DATETIME DEFAULT NULL,
    FOREIGN KEY (run_id) REFERENCES execution_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE CASCADE,
    INDEX idx_run_id (run_id),
    INDEX idx_script_status (script_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- Execution Logs (real-time log streaming)
-- ============================================================
CREATE TABLE execution_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    run_id INT NOT NULL,
    result_id INT DEFAULT NULL,
    log_level ENUM('INFO', 'WARN', 'ERROR', 'DEBUG') NOT NULL DEFAULT 'INFO',
    message TEXT NOT NULL,
    timestamp DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    FOREIGN KEY (run_id) REFERENCES execution_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (result_id) REFERENCES execution_results(id) ON DELETE CASCADE,
    INDEX idx_run_timestamp (run_id, timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- Scheduled Runs
-- ============================================================
CREATE TABLE scheduled_runs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    suite_id INT NOT NULL,
    cron_expression VARCHAR(100) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    environment VARCHAR(50) DEFAULT 'local',
    last_run_at DATETIME DEFAULT NULL,
    next_run_at DATETIME DEFAULT NULL,
    created_by INT DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (suite_id) REFERENCES test_suites(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- Seed Data
-- ============================================================

-- Default admin user (password: admin123 - bcrypt hashed)
INSERT INTO users (username, email, password_hash, full_name, role) VALUES
('admin', 'admin@noesis.com', '$2b$12$LJ3m4ys4Fp/hMN2K3EXAMPLE_HASH_REPLACE_ON_SETUP', 'System Admin', 'admin');

-- Script Categories
INSERT INTO script_categories (name, description, icon, color, sort_order) VALUES
('Configuration', 'Configuration screen test scripts', 'pi-cog', '#6366f1', 1),
('Feature', 'Feature-based test scripts', 'pi-star', '#f59e0b', 2),
('Manual', 'Manual screen E2E test scripts', 'pi-file-edit', '#10b981', 3),
('Sanity', 'Sanity and smoke test scripts', 'pi-check-circle', '#ef4444', 4),
('API', 'API integration test scripts', 'pi-server', '#8b5cf6', 5),
('Dashboard', 'Dashboard and UI test scripts', 'pi-chart-bar', '#06b6d4', 6),
('Security', 'Access and security test scripts', 'pi-shield', '#f97316', 7),
('Intake', 'Intake and processing test scripts', 'pi-inbox', '#ec4899', 8);

-- Register all discovered ST Scripts
INSERT INTO scripts (name, class_name, category_id, file_path, is_active) VALUES
-- Configuration Scripts
('Affiliate Screen Test', 'org.example.scripts.configuration.AffiliateScreenTest', 1, 'src/test/java/org/example/scripts/configuration/AffiliateScreenTest.java', TRUE),
('Folder Configuration E2E', 'org.example.scripts.configuration.FolderConfigurationE2ETest', 1, 'src/test/java/org/example/scripts/configuration/FolderConfigurationE2ETest.java', TRUE),
('Company Info Screen', 'org.example.scripts.configuration.CompanyInfoScreenTest', 1, 'src/test/java/org/example/scripts/configuration/CompanyInfoScreenTest.java', TRUE),
('Advance Rules E2E', 'org.example.scripts.configuration.AdvanceRulesE2ETest', 1, 'src/test/java/org/example/scripts/configuration/AdvanceRulesE2ETest.java', TRUE),
('Integration Screen', 'org.example.scripts.configuration.IntegrationScreenTest', 1, 'src/test/java/org/example/scripts/configuration/IntegrationScreenTest.java', TRUE),
('Literature Monitoring', 'org.example.scripts.configuration.LiteratureMonitoringTest', 1, 'src/test/java/org/example/scripts/configuration/LiteratureMonitoringTest.java', TRUE),
('Mailbox Configuration E2E', 'org.example.scripts.configuration.MailboxConfigurationE2ETest', 1, 'src/test/java/org/example/scripts/configuration/MailboxConfigurationE2ETest.java', TRUE),
('Reporting Destination E2E', 'org.example.scripts.configuration.ReportingDestinationE2ETest', 1, 'src/test/java/org/example/scripts/configuration/ReportingDestinationE2ETest.java', TRUE),
('User Group Configuration', 'org.example.scripts.configuration.UserGroupConfiguration', 1, 'src/test/java/org/example/scripts/configuration/UserGroupConfiguration.java', TRUE),
('User Screen E2E', 'org.example.scripts.configuration.UserScreenE2E', 1, 'src/test/java/org/example/scripts/configuration/UserScreenE2E.java', TRUE),
('User Screen Test', 'org.example.scripts.configuration.UserScreenTest', 1, 'src/test/java/org/example/scripts/configuration/UserScreenTest.java', TRUE),
('Auto Narrative Screen', 'org.example.scripts.configuration.AutoNarrativeScreen', 1, 'src/test/java/org/example/scripts/configuration/AutoNarrativeScreen.java', TRUE),

-- Feature Scripts
('Follow Up Query Management', 'org.example.scripts.feature.FollowUpQueryManagement', 2, 'src/test/java/org/example/scripts/feature/FollowUpQueryManagement.java', TRUE),
('Test Feature', 'org.example.scripts.feature.TestFeature', 2, 'src/test/java/org/example/scripts/feature/TestFeature.java', TRUE),
('Test HTML Feature', 'org.example.scripts.feature.TestHTMLFeature', 2, 'src/test/java/org/example/scripts/feature/TestHTMLFeature.java', TRUE),
('Test Single Case Feature', 'org.example.scripts.feature.TestSingleCaseFeature', 2, 'src/test/java/org/example/scripts/feature/TestSingleCaseFeature.java', TRUE),
('Test Text Feature', 'org.example.scripts.feature.TestTextFeature', 2, 'src/test/java/org/example/scripts/feature/TestTextFeature.java', TRUE),

-- Manual Scripts
('Manual Screen E2E Script 1', 'org.example.scripts.manual.ManualScreenE2E_Script1', 3, 'src/test/java/org/example/scripts/manual/ManualScreenE2E_Script1.java', TRUE),
('Manual Screen E2E Script 2', 'org.example.scripts.manual.ManualScreenE2E_Script2', 3, 'src/test/java/org/example/scripts/manual/ManualScreenE2E_Script2.java', TRUE),
('Manual Screen E2E Script 3', 'org.example.scripts.manual.ManualScreenE2E_Script3', 3, 'src/test/java/org/example/scripts/manual/ManualScreenE2E_Script3.java', TRUE),
('Manual Screen E2E Script 4', 'org.example.scripts.manual.ManualScreenE2E_Script4', 3, 'src/test/java/org/example/scripts/manual/ManualScreenE2E_Script4.java', TRUE),
('Manual Screen E2E Script 5', 'org.example.scripts.manual.ManualScreenE2E_Script5', 3, 'src/test/java/org/example/scripts/manual/ManualScreenE2E_Script5.java', TRUE),

-- Sanity Scripts
('RFC Sanity', 'org.example.scripts.RFCSanity', 4, 'src/test/java/org/example/scripts/RFCSanity.java', TRUE),
('Login Screen Test', 'org.example.scripts.LoginScreenTestCase', 4, 'src/test/java/org/example/scripts/LoginScreenTestCase.java', TRUE),

-- API Scripts
('API Test', 'org.example.scripts.APITest', 5, 'src/test/java/org/example/scripts/APITest.java', TRUE),

-- Dashboard Scripts
('User Dashboard', 'org.example.scripts.UserDashboard', 6, 'src/test/java/org/example/scripts/UserDashboard.java', TRUE),
('Worklist Screen', 'org.example.scripts.WorklistScreenTest', 6, 'src/test/java/org/example/scripts/WorklistScreenTest.java', TRUE),
('Action Logs', 'org.example.scripts.ActionLogsTest', 6, 'src/test/java/org/example/scripts/ActionLogsTest.java', TRUE),
('Audit Log Screen', 'org.example.scripts.AuditLogScreenTest', 6, 'src/test/java/org/example/scripts/AuditLogScreenTest.java', TRUE),
('Request Log Screen', 'org.example.scripts.RequestLogScreenTest', 6, 'src/test/java/org/example/scripts/RequestLogScreenTest.java', TRUE),
('Error Log', 'org.example.scripts.ErrorLog', 6, 'src/test/java/org/example/scripts/ErrorLog.java', TRUE),

-- Security Scripts
('Access Security Screen', 'org.example.scripts.AccessSecurityScreenTest', 7, 'src/test/java/org/example/scripts/AccessSecurityScreenTest.java', TRUE),

-- Intake & Processing Scripts
('R3 Intake', 'org.example.scripts.R3Intake', 8, 'src/test/java/org/example/scripts/R3Intake.java', TRUE),
('Auto Narrative', 'org.example.scripts.AutoNarrativeTest', 8, 'src/test/java/org/example/scripts/AutoNarrativeTest.java', TRUE),
('Doc Manual Translation', 'org.example.scripts.DocManualTranslation', 8, 'src/test/java/org/example/scripts/DocManualTranslation.java', TRUE),
('Inline Quota', 'org.example.scripts.InlineQuotaTest', 8, 'src/test/java/org/example/scripts/InlineQuotaTest.java', TRUE),
('Review Excel Extraction', 'org.example.scripts.ReviewExcelExtractionTest', 8, 'src/test/java/org/example/scripts/ReviewExcelExtractionTest.java', TRUE),
('Auto Archival Phase 1', 'org.example.scripts.AutoArchivalSystemPhase1Test', 8, 'src/test/java/org/example/scripts/AutoArchivalSystemPhase1Test.java', TRUE),
('Auto Archival Phase 2', 'org.example.scripts.AutoArchivalSystemPhase2Test', 8, 'src/test/java/org/example/scripts/AutoArchivalSystemPhase2Test.java', TRUE),
('Interim Manual Report', 'org.example.scripts.InterimManualReportTest', 8, 'src/test/java/org/example/scripts/InterimManualReportTest.java', TRUE),
('Post Processing Actions', 'org.example.scripts.PostProcessingActionsSystemTest', 8, 'src/test/java/org/example/scripts/PostProcessingActionsSystemTest.java', TRUE),
('Auto Assign', 'org.example.scripts.AutoAssign', 8, 'src/test/java/org/example/scripts/AutoAssign.java', TRUE),
('Download Rename', 'org.example.scripts.DownloadRename', 8, 'src/test/java/org/example/scripts/DownloadRename.java', TRUE);

-- Default Test Suites
INSERT INTO test_suites (name, description, created_by) VALUES
('Full Regression Suite', 'Complete regression suite with Configuration, Manual, and Feature tests', 1),
('Sanity Suite', 'Quick sanity checks for build verification', 1),
('Configuration Suite', 'All configuration screen tests', 1);
