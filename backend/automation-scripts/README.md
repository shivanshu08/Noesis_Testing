# Automation Script Naming

Automation scripts are organized by feature or screen under:

`src/test/java/org/example/scripts/<feature-or-screen>/`

Use descriptive class names that match the Java file name:

- `api/ApiHealthCheck.java`
- `dashboard/DashboardLoadTest.java`
- `manual/ManualWorkflowTest.java`
- `scriptmanagement/DuplicateScriptImportTest.java`
- `sync/SyncValidationConflictTest.java`

Avoid temporary names such as `Codex...`, timestamp suffixes, smoke-test placeholders, or verification-folder names.
