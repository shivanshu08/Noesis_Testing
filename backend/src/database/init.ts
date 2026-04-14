import { getPool } from './connection';
import { logger } from '../utils/logger';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';

async function initDatabase() {
  const pool = getPool();

  try {
    logger.info('Initializing database...');

    const schemaPath = path.join(__dirname, '../../../database/schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    // Execute the entire schema as one block (PostgreSQL handles IF NOT EXISTS)
    await pool.query(schema);
    logger.info('Schema applied successfully.');

    // Ensure unique constraints exist (for ON CONFLICT clauses)
    try {
      await pool.query(`ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username)`);
    } catch (e) {
      // Constraint may already exist
    }

    try {
      await pool.query(`ALTER TABLE script_categories ADD CONSTRAINT script_categories_name_key UNIQUE (name)`);
    } catch (e) {}

    try {
      await pool.query(`ALTER TABLE scripts ADD CONSTRAINT scripts_class_name_key UNIQUE (class_name)`);
    } catch (e) {}

    try {
      await pool.query(`ALTER TABLE test_suites ADD CONSTRAINT test_suites_name_key UNIQUE (name)`);
    } catch (e) {}

    // Ensure avatar_url can hold large base64 image strings
    try {
      await pool.query('ALTER TABLE users ALTER COLUMN avatar_url TYPE TEXT');
    } catch (e) {
      // Ignore if syntax differs or fails
    }

    // Ensure email is not mandatory
    try {
      await pool.query('ALTER TABLE users ALTER COLUMN email DROP NOT NULL');
    } catch (e) {}

    // Ensure user statistics columns exist
    try {
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS run_count INT NOT NULL DEFAULT 0');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS suites_created INT NOT NULL DEFAULT 0');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS scripts_registered INT NOT NULL DEFAULT 0');
    } catch (e) {
      // Ignore migration failures
    }

    // Ensure execution_logs supports rich diagnostics payload
    try {
      await pool.query('ALTER TABLE execution_logs ADD COLUMN IF NOT EXISTS detailed_description TEXT');
      await pool.query('ALTER TABLE execution_logs ADD COLUMN IF NOT EXISTS source_component VARCHAR(120)');
      await pool.query('ALTER TABLE execution_logs ADD COLUMN IF NOT EXISTS log_context JSONB');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_execution_logs_level ON execution_logs(log_level)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_execution_logs_component ON execution_logs(source_component)');
    } catch {
      // Ignore migration failures if schema is incompatible in older databases
    }

    // Ensure execution_runs supports run metadata payload (command, repo, artifacts)
    try {
      await pool.query('ALTER TABLE execution_runs ADD COLUMN IF NOT EXISTS run_metadata JSONB');
    } catch {
      // Ignore migration failures
    }

    // Ensure script dependency graph table exists
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS script_dependencies (
          id BIGSERIAL PRIMARY KEY,
          script_id INT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
          depends_on_script_id INT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
          created_by INT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT script_dependencies_no_self_dependency CHECK (script_id <> depends_on_script_id),
          UNIQUE (script_id, depends_on_script_id)
        )
      `);

      await pool.query('CREATE INDEX IF NOT EXISTS idx_script_dependencies_script ON script_dependencies(script_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_script_dependencies_depends_on ON script_dependencies(depends_on_script_id)');
    } catch {
      // Ignore migration failures
    }

    // Ensure script configuration resource snapshots table exists
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS script_configuration_resources (
          id BIGSERIAL PRIMARY KEY,
          script_id INT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
          resource_type VARCHAR(40) NOT NULL,
          reference_value VARCHAR(1000) NOT NULL,
          resolved_path VARCHAR(1200) DEFAULT NULL,
          exists_on_disk BOOLEAN NOT NULL DEFAULT FALSE,
          source_kind VARCHAR(40) NOT NULL DEFAULT 'parser',
          metadata JSONB DEFAULT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (script_id, resource_type, reference_value)
        )
      `);

      await pool.query('CREATE INDEX IF NOT EXISTS idx_script_config_resources_script ON script_configuration_resources(script_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_script_config_resources_type ON script_configuration_resources(resource_type)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_script_config_resources_exists ON script_configuration_resources(exists_on_disk)');

      await pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_trigger
            WHERE tgname = 'update_script_configuration_resources_updated_at'
          ) THEN
            CREATE TRIGGER update_script_configuration_resources_updated_at
            BEFORE UPDATE ON script_configuration_resources
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
          END IF;
        END $$;
      `);
    } catch {
      // Ignore migration failures
    }

    // Ensure script configuration file change audit table exists
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS script_configuration_change_logs (
          id BIGSERIAL PRIMARY KEY,
          script_id INT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
          file_path VARCHAR(1400) NOT NULL,
          file_type VARCHAR(40) NOT NULL,
          previous_content TEXT DEFAULT NULL,
          updated_content TEXT DEFAULT NULL,
          change_summary JSONB DEFAULT NULL,
          changed_by INT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
          changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query('CREATE INDEX IF NOT EXISTS idx_script_config_change_logs_script_time ON script_configuration_change_logs(script_id, changed_at DESC)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_script_config_change_logs_user_time ON script_configuration_change_logs(changed_by, changed_at DESC)');
    } catch {
      // Ignore migration failures
    }

    // Create admin user with proper bcrypt hash
    const salt = await bcrypt.genSalt(12);
    const adminHash = await bcrypt.hash('admin123', salt);

    try {
      await pool.query(
        'UPDATE users SET password_hash = $1 WHERE username = $2',
        [adminHash, 'admin']
      );
      logger.info('Admin user password updated.');
    } catch {
      // Admin user may not exist yet
    }

    // Seed scripts data - insert only if they don't exist
    try {
      const scriptsData: Array<[string, string, number, string, boolean]> = [
        // Configuration Scripts
        ['Affiliate Screen Test', 'org.example.scripts.configuration.AffiliateScreenTest', 1, 'src/test/java/org/example/scripts/configuration/AffiliateScreenTest.java', true],
        ['Folder Configuration E2E', 'org.example.scripts.configuration.FolderConfigurationE2ETest', 1, 'src/test/java/org/example/scripts/configuration/FolderConfigurationE2ETest.java', true],
        ['Company Info Screen', 'org.example.scripts.configuration.CompanyInfoScreenTest', 1, 'src/test/java/org/example/scripts/configuration/CompanyInfoScreenTest.java', true],
        ['Advance Rules E2E', 'org.example.scripts.configuration.AdvanceRulesE2ETest', 1, 'src/test/java/org/example/scripts/configuration/AdvanceRulesE2ETest.java', true],
        ['Integration Screen', 'org.example.scripts.configuration.IntegrationScreenTest', 1, 'src/test/java/org/example/scripts/configuration/IntegrationScreenTest.java', true],
        ['Literature Monitoring', 'org.example.scripts.configuration.LiteratureMonitoringTest', 1, 'src/test/java/org/example/scripts/configuration/LiteratureMonitoringTest.java', true],
        ['Mailbox Configuration E2E', 'org.example.scripts.configuration.MailboxConfigurationE2ETest', 1, 'src/test/java/org/example/scripts/configuration/MailboxConfigurationE2ETest.java', true],
        ['Reporting Destination E2E', 'org.example.scripts.configuration.ReportingDestinationE2ETest', 1, 'src/test/java/org/example/scripts/configuration/ReportingDestinationE2ETest.java', true],
        ['User Group Configuration', 'org.example.scripts.configuration.UserGroupConfiguration', 1, 'src/test/java/org/example/scripts/configuration/UserGroupConfiguration.java', true],
        ['User Screen E2E', 'org.example.scripts.configuration.UserScreenE2E', 1, 'src/test/java/org/example/scripts/configuration/UserScreenE2E.java', true],
        ['User Screen Test', 'org.example.scripts.configuration.UserScreenTest', 1, 'src/test/java/org/example/scripts/configuration/UserScreenTest.java', true],
        ['Auto Narrative Screen', 'org.example.scripts.configuration.AutoNarrativeScreen', 1, 'src/test/java/org/example/scripts/configuration/AutoNarrativeScreen.java', true],
        
        // Feature Scripts
        ['Follow Up Query Management', 'org.example.scripts.feature.FollowUpQueryManagement', 2, 'src/test/java/org/example/scripts/feature/FollowUpQueryManagement.java', true],
        ['Test Feature', 'org.example.scripts.feature.TestFeature', 2, 'src/test/java/org/example/scripts/feature/TestFeature.java', true],
        ['Test HTML Feature', 'org.example.scripts.feature.TestHTMLFeature', 2, 'src/test/java/org/example/scripts/feature/TestHTMLFeature.java', true],
        ['Test Single Case Feature', 'org.example.scripts.feature.TestSingleCaseFeature', 2, 'src/test/java/org/example/scripts/feature/TestSingleCaseFeature.java', true],
        ['Test Text Feature', 'org.example.scripts.feature.TestTextFeature', 2, 'src/test/java/org/example/scripts/feature/TestTextFeature.java', true],
        
        // Manual Scripts
        ['Manual Screen E2E Script 1', 'org.example.scripts.manual.ManualScreenE2E_Script1', 3, 'src/test/java/org/example/scripts/manual/ManualScreenE2E_Script1.java', true],
        ['Manual Screen E2E Script 2', 'org.example.scripts.manual.ManualScreenE2E_Script2', 3, 'src/test/java/org/example/scripts/manual/ManualScreenE2E_Script2.java', true],
        ['Manual Screen E2E Script 3', 'org.example.scripts.manual.ManualScreenE2E_Script3', 3, 'src/test/java/org/example/scripts/manual/ManualScreenE2E_Script3.java', true],
        ['Manual Screen E2E Script 4', 'org.example.scripts.manual.ManualScreenE2E_Script4', 3, 'src/test/java/org/example/scripts/manual/ManualScreenE2E_Script4.java', true],
        ['Manual Screen E2E Script 5', 'org.example.scripts.manual.ManualScreenE2E_Script5', 3, 'src/test/java/org/example/scripts/manual/ManualScreenE2E_Script5.java', true],
        
        // Sanity Scripts
        ['RFC Sanity', 'org.example.scripts.RFCSanity', 4, 'src/test/java/org/example/scripts/RFCSanity.java', true],
        ['Login Screen Test', 'org.example.scripts.LoginScreenTestCase', 4, 'src/test/java/org/example/scripts/LoginScreenTestCase.java', true],
        
        // API Scripts
        ['API Test', 'org.example.scripts.APITest', 5, 'src/test/java/org/example/scripts/APITest.java', true],
        
        // Dashboard Scripts
        ['User Dashboard', 'org.example.scripts.UserDashboard', 6, 'src/test/java/org/example/scripts/UserDashboard.java', true],
        ['Worklist Screen', 'org.example.scripts.WorklistScreenTest', 6, 'src/test/java/org/example/scripts/WorklistScreenTest.java', true],
        ['Action Logs', 'org.example.scripts.ActionLogsTest', 6, 'src/test/java/org/example/scripts/ActionLogsTest.java', true],
        ['Audit Log Screen', 'org.example.scripts.AuditLogScreenTest', 6, 'src/test/java/org/example/scripts/AuditLogScreenTest.java', true],
        ['Request Log Screen', 'org.example.scripts.RequestLogScreenTest', 6, 'src/test/java/org/example/scripts/RequestLogScreenTest.java', true],
        ['Error Log', 'org.example.scripts.ErrorLog', 6, 'src/test/java/org/example/scripts/ErrorLog.java', true],
        
        // Security Scripts
        ['Access Security Screen', 'org.example.scripts.AccessSecurityScreenTest', 7, 'src/test/java/org/example/scripts/AccessSecurityScreenTest.java', true],
        
        // Intake & Processing Scripts
        ['R3 Intake', 'org.example.scripts.R3Intake', 8, 'src/test/java/org/example/scripts/R3Intake.java', true],
        ['Auto Narrative', 'org.example.scripts.AutoNarrativeTest', 8, 'src/test/java/org/example/scripts/AutoNarrativeTest.java', true],
        ['Doc Manual Translation', 'org.example.scripts.DocManualTranslation', 8, 'src/test/java/org/example/scripts/DocManualTranslation.java', true],
        ['Inline Quota', 'org.example.scripts.InlineQuotaTest', 8, 'src/test/java/org/example/scripts/InlineQuotaTest.java', true],
        ['Review Excel Extraction', 'org.example.scripts.ReviewExcelExtractionTest', 8, 'src/test/java/org/example/scripts/ReviewExcelExtractionTest.java', true],
        ['Auto Archival Phase 1', 'org.example.scripts.AutoArchivalSystemPhase1Test', 8, 'src/test/java/org/example/scripts/AutoArchivalSystemPhase1Test.java', true],
        ['Auto Archival Phase 2', 'org.example.scripts.AutoArchivalSystemPhase2Test', 8, 'src/test/java/org/example/scripts/AutoArchivalSystemPhase2Test.java', true],
        ['Interim Manual Report', 'org.example.scripts.InterimManualReportTest', 8, 'src/test/java/org/example/scripts/InterimManualReportTest.java', true],
        ['Post Processing Actions', 'org.example.scripts.PostProcessingActionsSystemTest', 8, 'src/test/java/org/example/scripts/PostProcessingActionsSystemTest.java', true],
        ['Auto Assign', 'org.example.scripts.AutoAssign', 8, 'src/test/java/org/example/scripts/AutoAssign.java', true],
        ['Download Rename', 'org.example.scripts.DownloadRename', 8, 'src/test/java/org/example/scripts/DownloadRename.java', true],
      ];

      for (const [name, className, categoryId, filePath, isActive] of scriptsData) {
        try {
          await pool.query(
            `INSERT INTO scripts (name, class_name, category_id, file_path, is_active) 
             SELECT $1, $2, $3, $4, $5 
             WHERE NOT EXISTS (SELECT 1 FROM scripts WHERE class_name = $2)`,
            [name, className, categoryId, filePath, isActive]
          );
        } catch (e) {
          // Script may already exist, continue
        }
      }
      logger.info('Scripts seed data inserted successfully.');
    } catch (error) {
      logger.error('Error seeding scripts:', error);
    }

    logger.info('Database initialized successfully!');
    logger.info('Default credentials: admin / admin123');
  } catch (error) {
    logger.error('Database initialization failed:', error);
  } finally {
    await pool.end();
  }
}

initDatabase();
