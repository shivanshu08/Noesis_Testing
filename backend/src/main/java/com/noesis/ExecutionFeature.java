package com.noesis;


import com.sun.net.httpserver.HttpExchange;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;
import jakarta.mail.MessagingException;

class ExecutionFeature extends SuiteManagementFeature {
  private final ScheduledExecutorService scheduleExecutor = Executors.newSingleThreadScheduledExecutor();

  protected void run(HttpExchange ex, Auth auth) throws IOException, SQLException {
    edit(auth);
    Map<String, Object> b = body(ex);
    List<Integer> ids = intList(b.get("scriptIds"));
    if (ids.isEmpty()) throw new ApiException(400, "At least one script ID is required.");
    if ("tester".equals(auth.role) && !hasAssignedScripts(auth.userId, ids)) {
      throw new ApiException(403, "Access denied: One or more scripts are not assigned to you.");
    }
    ScriptExecutionPlan plan = resolveScriptExecutionPlan(ids);
    if (!plan.missingScriptIds.isEmpty()) throw new ApiException(400, "One or more scripts (or dependencies) are missing or inactive: " + plan.missingScriptIds);
    if (plan.orderedScriptIds.isEmpty()) throw new ApiException(400, "At least one valid script ID is required.");
    List<Map<String, Object>> scripts = scriptsForExecution(plan.orderedScriptIds);
    if (scripts.isEmpty()) throw new ApiException(400, "No valid active scripts found.");
    String runName = str(b.get("suiteName")).isBlank() ? "Run " + Instant.now().toString().replace('T', ' ').substring(0, 19) : str(b.get("suiteName"));
    String xml = buildTestNgXml(runName, scripts);
    Map<String, Object> created = db.one("INSERT INTO execution_runs (run_name, run_type, status, total_scripts, environment, config_xml, triggered_by, started_at) VALUES (?, ?::run_type, 'running'::run_status, ?, ?, ?, ?, NOW()) RETURNING id",
        runName, scripts.size() == 1 ? "single" : "custom", scripts.size(), b.getOrDefault("environment", "local"), xml, auth.userId);
    int runId = intValue(created.get("id"), 0);
    for (Map<String, Object> script : scripts) db.update("INSERT INTO execution_results (run_id, script_id, status) VALUES (?, ?, 'queued'::result_status)", runId, script.get("id"));
    db.update("UPDATE users SET run_count = COALESCE(run_count, 0) + 1 WHERE id = ?", auth.userId);
    startExecution(runId, runName, xml, scripts);
    send(ex, 201, Map.of("runId", runId, "message", "Execution started.", "totalScripts", scripts.size(), "resolvedScriptIds", plan.orderedScriptIds, "autoIncludedDependencyIds", plan.autoIncludedDependencyIds));
  }

  protected List<Map<String, Object>> scriptsForExecution(List<Integer> orderedIds) throws SQLException {
    List<Map<String, Object>> rows = db.rows("SELECT id, name, class_name, method_name FROM scripts WHERE is_active = TRUE AND id IN (" + placeholders(orderedIds.size()) + ")", orderedIds.toArray());
    Map<Integer, Map<String, Object>> byId = new LinkedHashMap<>();
    for (Map<String, Object> row : rows) byId.put(intValue(row.get("id"), 0), row);
    List<Map<String, Object>> ordered = new ArrayList<>();
    for (Integer id : orderedIds) {
      Map<String, Object> row = byId.get(id);
      if (row != null) ordered.add(row);
    }
    return ordered;
  }

  protected void stopRun(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    edit(auth);
    Process p = activeProcesses.remove(id);
    if (p != null) p.destroy();
    db.update("UPDATE execution_runs SET status = 'stopped'::run_status, completed_at = NOW() WHERE id = ?", id);
    db.update("UPDATE execution_results SET status = 'skipped'::result_status WHERE run_id = ? AND status IN ('queued','running')", id);
    send(ex, 200, message("Execution stopped."));
  }

  protected void runs(HttpExchange ex, Auth auth, Map<String, String> q) throws IOException, SQLException {
    reconcileAbandonedRunningRuns();
    List<Object> params = new ArrayList<>();
    String where = "WHERE 1=1";
    if (q.containsKey("status") && !q.get("status").isBlank()) { where += " AND er.status = ?::run_status"; params.add(q.get("status")); }
    if ("tester".equals(auth.role)) {
      where += " AND EXISTS (SELECT 1 FROM execution_results eres WHERE eres.run_id = er.id AND eres.script_id IN (SELECT sa.script_id FROM script_assignments sa WHERE sa.user_id = ?))";
      params.add(auth.userId);
    }
    params.add(Integer.parseInt(q.getOrDefault("limit", "50")));
    params.add(Integer.parseInt(q.getOrDefault("offset", "0")));
    List<Map<String, Object>> rows = db.rows("""
        SELECT er.id, er.run_name, er.run_type, er.suite_id, er.status, er.total_scripts,
          er.passed_count, er.failed_count, er.error_count, er.skipped_count,
          er.duration_ms, er.environment, er.run_metadata, er.triggered_by,
          er.started_at, er.completed_at, er.created_at,
          u.full_name AS triggered_by_name,
          COALESCE(ac.artifact_count, 0)::int AS artifact_count
        FROM execution_runs er
        LEFT JOIN users u ON er.triggered_by = u.id
        LEFT JOIN (
          SELECT run_id, COUNT(*)::int AS artifact_count
          FROM execution_artifacts
          WHERE artifact_type IN ('html', 'pdf')
          GROUP BY run_id
        ) ac ON ac.run_id = er.id
        """ + where + " ORDER BY er.created_at DESC LIMIT ? OFFSET ?", params.toArray());
    for (Map<String, Object> row : rows) {
      row.put("runMetadata", enrichRunListMetadata(row));
      shapeRunResponse(row);
    }
    send(ex, 200, rows);
  }

  @SuppressWarnings("unchecked")
  protected Map<String, Object> enrichRunListMetadata(Map<String, Object> run) {
    Map<String, Object> metadata = new LinkedHashMap<>();
    Object raw = run.get("runMetadata");
    if (raw instanceof Map<?, ?> map) {
      for (Map.Entry<?, ?> entry : map.entrySet()) metadata.put(str(entry.getKey()), entry.getValue());
    }
    putDefault(metadata, "executionSource", env.value("ST_AUTOMATION_SOURCE", "git"));
    putDefault(metadata, "gitRepoUrl", gitRepositoryUrl());
    putDefault(metadata, "gitRepoName", gitRepositoryName());
    putDefault(metadata, "gitBranch", env.value("ST_AUTOMATION_GIT_BRANCH", "main"));
    putDefault(metadata, "workspacePath", env.value("ST_AUTOMATION_GIT_CACHE_PATH", env.value("ST_AUTOMATION_PATH", "")));
    putDefault(metadata, "environment", str(run.get("environment")));
    putDefault(metadata, "startedAt", str(run.get("startedAt")));
    putDefault(metadata, "completedAt", str(run.get("completedAt")));
    putDefault(metadata, "finalStatus", str(run.get("status")));
    int artifactCount = intValue(run.get("artifactCount"), 0);
    if (artifactCount > 0) putDefault(metadata, "artifactCount", artifactCount);
    return metadata;
  }

  protected void runDetails(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    reconcileFinishedRunIfNeeded(id);
    Map<String, Object> run = db.one("SELECT er.*, u.full_name AS triggered_by_name FROM execution_runs er LEFT JOIN users u ON er.triggered_by = u.id WHERE er.id = ?", id);
    if (run == null) throw new ApiException(404, "Run not found.");
    if ("tester".equals(auth.role)) {
      int visible = intValue(db.one("""
          SELECT COUNT(*)::int AS count
          FROM execution_results eres
          WHERE eres.run_id = ? AND eres.script_id IN (SELECT script_id FROM script_assignments WHERE user_id = ?)
          """, id, auth.userId).get("count"), 0);
      if (visible == 0) throw new ApiException(403, "Access denied: You are not assigned to any scripts in this execution run.");
    }
    List<Map<String, Object>> results = db.rows("SELECT eres.*, s.name AS script_name, s.class_name FROM execution_results eres JOIN scripts s ON eres.script_id = s.id WHERE eres.run_id = ? ORDER BY eres.id", id);
    run.put("results", results);
    run.put("runMetadata", enrichRunMetadata(run));
    shapeRunResponse(run);
    send(ex, 200, run);
  }

  protected void shapeRunResponse(Map<String, Object> run) {
    Object displayName = firstNonBlank(str(run.get("triggeredByName")), str(run.get("username")), "System");
    run.put("triggeredBy", displayName);
  }

  protected void stats(HttpExchange ex, Auth auth) throws IOException, SQLException {
    reconcileAbandonedRunningRuns();
    Object[] userParam = "tester".equals(auth.role) ? new Object[]{auth.userId} : new Object[]{};
    String runFilter = "tester".equals(auth.role)
        ? " WHERE EXISTS (SELECT 1 FROM execution_results eres WHERE eres.run_id = er.id AND eres.script_id IN (SELECT sa.script_id FROM script_assignments sa WHERE sa.user_id = ?))"
        : "";
    String andOrWhere = runFilter.isBlank() ? " WHERE " : " AND ";
    boolean tester = "tester".equals(auth.role);
    Object[] historyParams = tester ? new Object[]{auth.userId, auth.userId} : userParam;

    Number totalScripts = tester
        ? (Number) db.one("""
            SELECT COUNT(*)::int AS count
            FROM scripts s
            JOIN script_assignments sa ON sa.script_id = s.id
            WHERE s.is_active = TRUE AND sa.user_id = ?
            """, auth.userId).get("count")
        : (Number) db.one("SELECT COUNT(*)::int AS count FROM scripts WHERE is_active = TRUE").get("count");
    Number totalRuns = (Number) db.one("SELECT COUNT(*)::int AS count FROM execution_runs er" + runFilter, userParam).get("count");
    Number recentRuns = (Number) db.one("SELECT COUNT(*)::int AS count FROM execution_runs er" + runFilter + andOrWhere + "er.created_at >= NOW() - INTERVAL '7 days'", userParam).get("count");
    Number running = (Number) db.one("SELECT COUNT(*)::int AS count FROM execution_runs er" + runFilter + andOrWhere + "er.status = 'running'", userParam).get("count");
    Object passRate = db.one("SELECT COALESCE(ROUND(AVG(CASE WHEN er.status = 'passed' THEN 100 ELSE 0 END), 1), 0) AS rate FROM execution_runs er" + runFilter + andOrWhere + "er.status IN ('passed','failed') AND er.created_at >= NOW() - INTERVAL '30 days'", userParam).get("rate");
    List<Map<String, Object>> recentHistory = db.rows("""
        SELECT er.created_at::date AS date, 'passed' AS status, COALESCE(SUM(er.passed_count), 0)::int AS count
        FROM execution_runs er
        """ + runFilter + andOrWhere + "er.created_at >= NOW() - INTERVAL '30 days' GROUP BY er.created_at::date " + """
        UNION ALL
        SELECT er.created_at::date AS date, 'failed' AS status, COALESCE(SUM(er.failed_count + er.error_count), 0)::int AS count
        FROM execution_runs er
        """ + runFilter + andOrWhere + "er.created_at >= NOW() - INTERVAL '30 days' GROUP BY er.created_at::date ORDER BY date", historyParams);
    List<Map<String, Object>> categoryStats = db.rows("""
        SELECT sc.name, sc.color, COUNT(s.id)::int AS count
        FROM script_categories sc
        LEFT JOIN scripts s ON s.category_id = sc.id AND s.is_active = TRUE
          """ + (tester ? "AND s.id IN (SELECT script_id FROM script_assignments WHERE user_id = ?) " : "") + """
        GROUP BY sc.id ORDER BY sc.sort_order
        """, tester ? new Object[]{auth.userId} : userParam);
    send(ex, 200, Map.of("totalScripts", totalScripts, "totalRuns", totalRuns, "recentRuns", recentRuns, "passRate", passRate, "runningCount", running, "recentHistory", recentHistory, "categoryStats", categoryStats));
  }

  protected void executionLogs(HttpExchange ex, int runId) throws IOException, SQLException {
    send(ex, 200, db.rows("SELECT id, run_id, log_level AS level, message, timestamp FROM execution_logs WHERE run_id = ? ORDER BY timestamp ASC, id ASC", runId));
  }

  protected void artifacts(HttpExchange ex, int runId) throws IOException, SQLException {
    reconcileFinishedRunIfNeeded(runId);
    List<Map<String, Object>> rows = artifactRows(runId);
    List<Map<String, Object>> visible = visibleArtifacts(runId, rows);
    if (visible.isEmpty()) {
      ensureOutputArtifactsForRun(runId);
      visible = visibleArtifacts(runId, artifactRows(runId));
    }
    send(ex, 200, visible);
  }

  protected void reconcileFinishedRunIfNeeded(int runId) {
    try {
      Map<String, Object> run = db.one("SELECT run_name, status, total_scripts FROM execution_runs WHERE id = ?", runId);
      if (run == null || !"running".equalsIgnoreCase(str(run.get("status"))) || activeProcesses.containsKey(runId)) return;

      List<Map<String, Object>> logRows = db.rows("SELECT message FROM execution_logs WHERE run_id = ? ORDER BY timestamp ASC, id ASC", runId);
      String output = logRows.stream().map(row -> str(row.get("message"))).collect(Collectors.joining(System.lineSeparator()));
      String lower = output.toLowerCase(Locale.ROOT);
      boolean buildSuccess = lower.contains("build success");
      boolean buildFailure = lower.contains("build failure");
      if (!buildSuccess && !buildFailure) return;

      ResultSummary summary = parseTestResults(output);
      int totalScripts = Math.max(1, intValue(run.get("totalScripts"), 1));
      if (summary.total() == 0) {
        summary = buildSuccess ? new ResultSummary(totalScripts, 0, 0, 0) : new ResultSummary(0, totalScripts, 0, 0);
      }
      String status = buildSuccess && summary.failed == 0 && summary.errors == 0 ? "passed" : "failed";

      db.update("UPDATE execution_runs SET status = ?::run_status, passed_count = ?, failed_count = ?, error_count = ?, skipped_count = ?, completed_at = COALESCE(completed_at, NOW()), duration_ms = COALESCE(duration_ms, EXTRACT(EPOCH FROM (NOW() - started_at))::int * 1000), run_metadata = COALESCE(run_metadata, '{}'::jsonb) || ?::jsonb WHERE id = ? AND status = 'running'::run_status",
          status, summary.passed, summary.failed, summary.errors, summary.skipped,
          json(Map.of("finalStatus", status, "reconciledFromLogs", true, "completedAt", Instant.now().toString(),
              "resultSummary", Map.of("passed", summary.passed, "failed", summary.failed, "errors", summary.errors, "skipped", summary.skipped))), runId);
      db.update("UPDATE execution_results SET status = ?::result_status, completed_at = COALESCE(completed_at, NOW()), log_output = COALESCE(log_output, ?) WHERE run_id = ? AND status IN ('queued','running')", status, output, runId);
      ensureOutputArtifactsForRun(runId);
      sendExecutionCompletionMail(runId, str(run.getOrDefault("runName", "Run #" + runId)), status, summary, null);
    } catch (Exception ignored) {}
  }

  protected void reconcileAbandonedRunningRuns() {
    try {
      int staleMinutes = Math.max(5, env.intValue("EXECUTION_STALE_GRACE_MINUTES", 120));
      List<Map<String, Object>> rows = db.rows("""
          SELECT id, run_name, total_scripts
          FROM execution_runs
          WHERE status = 'running'::run_status
            AND (started_at IS NULL OR started_at <= NOW() - (? || ' minutes')::interval)
          ORDER BY started_at ASC NULLS FIRST
          LIMIT 100
          """, staleMinutes);

      for (Map<String, Object> row : rows) {
        int runId = intValue(row.get("id"), 0);
        if (runId <= 0 || activeProcesses.containsKey(runId)) continue;

        reconcileFinishedRunIfNeeded(runId);
        Map<String, Object> current = db.one("SELECT status FROM execution_runs WHERE id = ?", runId);
        if (current == null || !"running".equalsIgnoreCase(str(current.get("status")))) continue;

        int totalScripts = Math.max(1, intValue(row.get("totalScripts"), 1));
        String message = "Execution was marked as error because the backend no longer has an active process for this stale running run.";
        db.update("""
            UPDATE execution_runs
            SET status = 'error'::run_status,
                error_count = GREATEST(COALESCE(error_count, 0), ?),
                completed_at = COALESCE(completed_at, NOW()),
                duration_ms = COALESCE(duration_ms, EXTRACT(EPOCH FROM (NOW() - started_at))::int * 1000),
                run_metadata = COALESCE(run_metadata, '{}'::jsonb) || ?::jsonb
            WHERE id = ? AND status = 'running'::run_status
            """, totalScripts, json(Map.of(
                "finalStatus", "error",
                "abandonedRunningRun", true,
                "reconciledAt", Instant.now().toString(),
                "staleGraceMinutes", staleMinutes)), runId);
        db.update("""
            UPDATE execution_results
            SET status = 'error'::result_status,
                completed_at = COALESCE(completed_at, NOW()),
                error_message = COALESCE(error_message, ?)
            WHERE run_id = ? AND status IN ('queued','running')
            """, message, runId);
        logExecution(runId, "WARN", message);
      }
    } catch (Exception ignored) {}
  }

  protected List<Map<String, Object>> artifactRows(int runId) throws SQLException {
    return db.rows("""
        SELECT * FROM execution_artifacts
        WHERE run_id = ? AND artifact_type IN ('html', 'pdf')
        ORDER BY
          CASE
            WHEN file_name ILIKE 'execution-output.%%' THEN 3
            WHEN artifact_type = 'html' THEN 0
            WHEN artifact_type = 'pdf' THEN 1
            ELSE 3
          END,
          created_at ASC
        """, runId);
  }

  protected List<Map<String, Object>> visibleArtifacts(int runId, List<Map<String, Object>> rows) throws SQLException {
    List<String> scriptNames = db.rows("""
        SELECT LOWER(s.name) AS name
        FROM execution_results er
        JOIN scripts s ON s.id = er.script_id
        WHERE er.run_id = ?
        """, runId).stream().map(row -> str(row.get("name"))).filter(s -> !s.isBlank()).toList();
    List<Map<String, Object>> visible = rows.stream().filter(row -> displayArtifact(row, scriptNames)).toList();
    boolean hasRealSurefireReport = visible.stream().anyMatch(row -> !isGeneratedOutputArtifact(str(row.get("fileName"))));
    if (!hasRealSurefireReport) return visible;
    return oneHtmlPdfPair(visible.stream().filter(row -> !isGeneratedOutputArtifact(str(row.get("fileName")))).toList());
  }

  protected List<Map<String, Object>> oneHtmlPdfPair(List<Map<String, Object>> artifacts) {
    List<Map<String, Object>> html = artifacts.stream().filter(row -> "html".equalsIgnoreCase(str(row.get("artifactType")))).toList();
    List<Map<String, Object>> pdf = artifacts.stream().filter(row -> "pdf".equalsIgnoreCase(str(row.get("artifactType")))).toList();
    if (html.size() <= 1 && pdf.size() <= 1) return artifacts;

    Map<String, Object> selectedHtml = null;
    Map<String, Object> selectedPdf = null;
    for (Map<String, Object> candidateHtml : html) {
      String base = artifactBaseName(str(candidateHtml.get("fileName")));
      Map<String, Object> matchingPdf = pdf.stream()
          .filter(row -> artifactBaseName(str(row.get("fileName"))).equalsIgnoreCase(base))
          .findFirst()
          .orElse(null);
      if (matchingPdf != null) {
        selectedHtml = candidateHtml;
        selectedPdf = matchingPdf;
        break;
      }
    }
    if (selectedHtml == null) selectedHtml = html.isEmpty() ? null : html.get(0);
    if (selectedPdf == null) selectedPdf = pdf.isEmpty() ? null : pdf.get(0);

    List<Map<String, Object>> selected = new ArrayList<>();
    if (selectedHtml != null) selected.add(selectedHtml);
    if (selectedPdf != null) selected.add(selectedPdf);
    return selected;
  }

  protected String artifactBaseName(String fileName) {
    String name = Path.of(fileName).getFileName().toString();
    int dot = name.lastIndexOf('.');
    return dot > 0 ? name.substring(0, dot) : name;
  }

  protected void artifactDownload(HttpExchange ex, int id) throws IOException, SQLException {
    Map<String, Object> artifact = db.one("SELECT * FROM execution_artifacts WHERE id = ?", id);
    if (artifact == null || artifact.get("storedPath") == null) throw new ApiException(404, "Artifact not found.");
    Path path = Path.of(str(artifact.get("storedPath")));
    if (!Files.exists(path)) throw new ApiException(404, "Artifact file not found on disk.");
    ex.getResponseHeaders().add("Content-Disposition", "attachment; filename=\"" + artifact.get("fileName") + "\"");
    sendBytes(ex, 200, Files.readAllBytes(path));
  }

  protected void mailArtifacts(HttpExchange ex) throws IOException, SQLException {
    if (!Boolean.parseBoolean(env.value("MAIL_ENABLED", "false"))) throw new ApiException(503, "Mail is disabled.");
    if (env.value("SMTP_HOST", "").isBlank() || env.value("SMTP_USER", "").isBlank() || env.value("SMTP_PASSWORD", "").isBlank()) {
      throw new ApiException(503, "SMTP is not configured.");
    }

    int runId = id(ex.getRequestURI().getPath());
    Map<String, Object> b = body(ex);
    List<String> recipients = stringList(b.get("recipients"));
    List<Integer> artifactIds = intList(b.get("artifactIds"));
    if (recipients.isEmpty()) throw new ApiException(400, "At least one recipient is required.");
    if (artifactIds.isEmpty()) throw new ApiException(400, "Select at least one artifact to attach.");

    List<Map<String, Object>> artifacts = db.rows(
        "SELECT * FROM execution_artifacts WHERE run_id = ? AND id IN (" + placeholders(artifactIds.size()) + ") ORDER BY id",
        prepend(runId, artifactIds).toArray());
    if (artifacts.isEmpty()) throw new ApiException(404, "Selected artifacts were not found for this run.");

    String subject = str(b.getOrDefault("subject", "Noesis artifacts for Run #" + runId));
    String message = str(b.getOrDefault("message", "Please find the selected execution artifacts attached."));
    CompletableFuture.runAsync(() -> {
      try {
        sendMail(recipients, subject, message, artifacts);
        db.update("INSERT INTO app_logs (severity, module, action, status, message, metadata) VALUES ('INFO', 'execution', 'ARTIFACT_MAIL', 'SUCCESS', ?, ?::jsonb)",
            "Execution artifacts mailed successfully.", json(Map.of("runId", runId, "artifactCount", artifacts.size(), "recipientCount", recipients.size())));
      } catch (Exception e) {
        try {
          db.update("INSERT INTO app_logs (severity, module, action, status, message, metadata) VALUES ('ERROR', 'execution', 'ARTIFACT_MAIL', 'FAILED', ?, ?::jsonb)",
              "Execution artifact mail failed: " + e.getMessage(), json(Map.of("runId", runId, "artifactCount", artifacts.size(), "recipientCount", recipients.size())));
        } catch (Exception ignored) {}
      }
    });
    send(ex, 202, Map.of("message", "Selected artifacts are being mailed in the background.", "artifactCount", artifacts.size(), "recipientCount", recipients.size()));
  }

  protected void globalLogs(HttpExchange ex, Map<String, String> q) throws IOException, SQLException {
    int limit = Math.max(1, Math.min(500, intValue(q.get("limit"), 200)));
    int offset = Math.max(0, intValue(q.get("offset"), 0));
    List<Object> params = new ArrayList<>();
    StringBuilder where = new StringBuilder("WHERE 1=1");
    if (q.containsKey("severity") && !q.get("severity").isBlank()) {
      where.append(" AND LOWER(severity) = LOWER(?)");
      params.add(q.get("severity"));
    }
    if (q.containsKey("runId") && !q.get("runId").isBlank()) {
      where.append(" AND run_id = ?");
      params.add(intValue(q.get("runId"), 0));
    }
    if (q.containsKey("module") && !q.get("module").isBlank()) {
      where.append(" AND LOWER(module) = LOWER(?)");
      params.add(q.get("module"));
    }
    if (q.containsKey("action") && !q.get("action").isBlank()) {
      where.append(" AND action = ?");
      params.add(q.get("action"));
    }
    if (q.containsKey("status") && !q.get("status").isBlank()) {
      where.append(" AND LOWER(status) = LOWER(?)");
      params.add(q.get("status"));
    }
    if (q.containsKey("q") && !q.get("q").isBlank()) {
      where.append(" AND (message ILIKE ? OR COALESCE(detail,'') ILIKE ? OR COALESCE(action,'') ILIKE ? OR COALESCE(module,'') ILIKE ?)");
      String term = "%" + q.get("q").trim() + "%";
      params.add(term); params.add(term); params.add(term); params.add(term);
    }
    if (q.containsKey("from") && !q.get("from").isBlank()) {
      where.append(" AND timestamp >= ?::timestamp");
      params.add(q.get("from"));
    } else if (q.containsKey("days") && !q.get("days").isBlank()) {
      where.append(" AND timestamp >= NOW() - (? || ' days')::interval");
      params.add(Math.max(1, Math.min(365, intValue(q.get("days"), 30))));
    }
    if (q.containsKey("to") && !q.get("to").isBlank()) {
      where.append(" AND timestamp <= ?::timestamp");
      params.add(q.get("to"));
    }
    String sortBy = Set.of("timestamp", "severity", "module", "action", "status").contains(q.get("sortBy")) ? q.get("sortBy") : "timestamp";
    String sortOrder = "asc".equalsIgnoreCase(q.get("sortOrder")) ? "ASC" : "DESC";
    String base = """
        WITH unified_logs AS (
          SELECT id, NULL::int AS run_id, NULL::int AS result_id, UPPER(COALESCE(severity, 'INFO')) AS severity,
            message, message AS summary, message AS detail, COALESCE(module, 'application') AS module,
            action, status, username, timestamp, metadata, 'application' AS source
          FROM app_logs
          UNION ALL
          SELECT id, run_id, result_id, UPPER(COALESCE(log_level::text, 'INFO')) AS severity,
            message, message AS summary, COALESCE(detailed_description, message) AS detail,
            COALESCE(source_component, 'execution-engine') AS module,
            NULL::text AS action, NULL::text AS status, NULL::text AS username, timestamp,
            jsonb_build_object('sourceComponent', source_component, 'context', log_context) AS metadata, 'execution' AS source
          FROM execution_logs
        )
        """;
    Number total = (Number) db.one(base + "SELECT COUNT(*)::int AS count FROM unified_logs " + where, params.toArray()).get("count");
    Number errorCount = (Number) db.one(base + "SELECT COUNT(*)::int AS count FROM unified_logs " + where + " AND LOWER(severity) = 'error'", params.toArray()).get("count");
    Number warnCount = (Number) db.one(base + "SELECT COUNT(*)::int AS count FROM unified_logs " + where + " AND LOWER(severity) = 'warn'", params.toArray()).get("count");
    Number infoCount = (Number) db.one(base + "SELECT COUNT(*)::int AS count FROM unified_logs " + where + " AND LOWER(severity) = 'info'", params.toArray()).get("count");
    Number debugCount = (Number) db.one(base + "SELECT COUNT(*)::int AS count FROM unified_logs " + where + " AND LOWER(severity) = 'debug'", params.toArray()).get("count");
    Number uniqueRunCount = (Number) db.one(base + "SELECT COUNT(DISTINCT run_id)::int AS count FROM unified_logs " + where + " AND run_id IS NOT NULL", params.toArray()).get("count");
    List<Object> dataParams = new ArrayList<>(params);
    dataParams.add(limit); dataParams.add(offset);
    List<Map<String, Object>> data = db.rows(base + """
        SELECT id, run_id, result_id, LOWER(severity) AS severity, message, summary, detail, module, action, status, username, timestamp, timestamp AS time, metadata, source
        FROM unified_logs
        """ + where + " ORDER BY " + sortBy + " " + sortOrder + ", id " + sortOrder + " LIMIT ? OFFSET ?", dataParams.toArray());
    send(ex, 200, Map.of(
        "data", data,
        "summary", Map.of("total", total, "errorCount", errorCount, "warnCount", warnCount, "infoCount", infoCount, "debugCount", debugCount, "uniqueRunCount", uniqueRunCount),
        "meta", Map.of("total", total, "limit", limit, "offset", offset)));
  }

  protected void deleteGlobalLog(HttpExchange ex, int id) throws IOException, SQLException {
    db.update("DELETE FROM app_logs WHERE id = ?", id);
    send(ex, 200, Map.of("success", true));
  }

  protected void deleteGlobalLogs(HttpExchange ex) throws IOException, SQLException {
    List<Integer> ids = intList(body(ex).get("ids"));
    if (!ids.isEmpty()) db.update("DELETE FROM app_logs WHERE id IN (" + placeholders(ids.size()) + ")", ids.toArray());
    send(ex, 200, Map.of("success", true));
  }

  protected void createSchedule(HttpExchange ex, Auth auth) throws IOException, SQLException {
    edit(auth);
    Map<String, Object> b = body(ex);
    List<Integer> scriptIds = intList(b.get("scriptIds"));
    Integer suiteId = intValue(b.get("suiteId"), 0);
    if (str(b.get("name")).trim().isBlank()) throw new ApiException(400, "Schedule name is required.");
    if (str(b.get("cronExpression")).trim().isBlank() || nextRunAt(str(b.get("cronExpression")), false) == null) throw new ApiException(400, "Invalid cron expression.");
    if (scriptIds.isEmpty() && suiteId <= 0) throw new ApiException(400, "Either script IDs or a suite ID is required.");
    if ("tester".equals(auth.role)) {
      List<Integer> toCheck = new ArrayList<>(scriptIds);
      if (suiteId > 0) toCheck.addAll(suiteScriptIds(suiteId));
      if (!hasAssignedScripts(auth.userId, toCheck)) throw new ApiException(403, "Access denied: One or more scripts in this selection/suite are not assigned to you.");
    }
    boolean oneTime = Boolean.TRUE.equals(b.getOrDefault("isOneTime", false));
    Object nextRunAt = nextRunAt(str(b.get("cronExpression")), oneTime);
    Map<String, Object> created = db.one("INSERT INTO scheduled_runs (name, suite_id, script_ids, cron_expression, environment, description, is_one_time, next_run_at, created_by) VALUES (?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?) RETURNING *",
        str(b.get("name")).trim(), suiteId > 0 ? suiteId : null, scriptIds.isEmpty() ? null : json(scriptIds), b.get("cronExpression"), b.getOrDefault("environment", "local"), b.get("description"), oneTime, nextRunAt, auth.userId);
    send(ex, 201, created);
  }

  protected void schedules(HttpExchange ex) throws IOException, SQLException {
    send(ex, 200, db.rows("SELECT sr.*, u.full_name AS created_by_name FROM scheduled_runs sr LEFT JOIN users u ON sr.created_by = u.id ORDER BY sr.created_at DESC"));
  }

  protected void updateSchedule(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    edit(auth);
    Map<String, Object> b = body(ex);
    Object nextRunAt = b.containsKey("cronExpression") || b.containsKey("isOneTime")
        ? nextRunAt(str(b.get("cronExpression")), Boolean.TRUE.equals(b.getOrDefault("isOneTime", false)))
        : null;
    if (b.containsKey("cronExpression") && nextRunAt == null) throw new ApiException(400, "Invalid cron expression.");
    db.update("UPDATE scheduled_runs SET name = COALESCE(?, name), cron_expression = COALESCE(?, cron_expression), is_active = COALESCE(?, is_active), environment = COALESCE(?, environment), description = COALESCE(?, description), is_one_time = COALESCE(?, is_one_time), next_run_at = COALESCE(?, next_run_at) WHERE id = ?",
        b.get("name"), b.get("cronExpression"), b.get("isActive"), b.get("environment"), b.get("description"), b.get("isOneTime"), nextRunAt, id);
    send(ex, 200, message("Schedule updated."));
  }

  protected void deleteSchedule(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    edit(auth);
    db.update("DELETE FROM scheduled_runs WHERE id = ?", id);
    send(ex, 200, message("Schedule deleted."));
  }

  protected List<Integer> suiteScriptIds(int suiteId) throws SQLException {
    return db.rows("SELECT script_id FROM suite_scripts WHERE suite_id = ? ORDER BY execution_order", suiteId).stream()
        .map(row -> intValue(row.get("scriptId"), 0))
        .filter(id -> id > 0)
        .toList();
  }

  protected void initScheduler() {
    scheduleExecutor.scheduleWithFixedDelay(this::runDueSchedulesSafely, 10, 60, TimeUnit.SECONDS);
  }

  protected void shutdownScheduler() {
    scheduleExecutor.shutdownNow();
  }

  private void runDueSchedulesSafely() {
    try {
      for (Map<String, Object> schedule : db.rows("""
          SELECT * FROM scheduled_runs
          WHERE is_active = TRUE AND next_run_at IS NOT NULL AND next_run_at <= NOW()
          ORDER BY next_run_at ASC
          LIMIT 10
          """)) {
        executeScheduledRun(schedule);
      }
    } catch (Exception e) {
      try { db.update("INSERT INTO app_logs (severity, module, action, status, message) VALUES ('ERROR', 'scheduler', 'SCHEDULE_SCAN', 'FAILED', ?)", e.getMessage()); } catch (Exception ignored) {}
    }
  }

  protected void executeScheduledRun(Map<String, Object> schedule) throws SQLException, IOException {
    int scheduleId = intValue(schedule.get("id"), 0);
    List<Integer> scriptIds = intList(schedule.get("scriptIds"));
    int suiteId = intValue(schedule.get("suiteId"), 0);
    if (scriptIds.isEmpty() && suiteId > 0) scriptIds = suiteScriptIds(suiteId);
    if (scriptIds.isEmpty()) {
      db.update("UPDATE scheduled_runs SET last_run_at = NOW(), next_run_at = NULL, is_active = FALSE WHERE id = ?", scheduleId);
      return;
    }
    ScriptExecutionPlan plan = resolveScriptExecutionPlan(scriptIds);
    if (!plan.missingScriptIds.isEmpty() || plan.orderedScriptIds.isEmpty()) {
      db.update("INSERT INTO app_logs (severity, module, action, status, message, metadata) VALUES ('WARN', 'scheduler', 'SCHEDULED_RUN_SKIPPED', 'FAILED', ?, ?::jsonb)",
          "Scheduled run skipped because scripts are missing or inactive.", json(Map.of("scheduleId", scheduleId, "missingScriptIds", plan.missingScriptIds)));
      db.update("UPDATE scheduled_runs SET last_run_at = NOW(), next_run_at = ? WHERE id = ?", nextRunAt(str(schedule.get("cronExpression")), Boolean.TRUE.equals(schedule.get("isOneTime"))), scheduleId);
      return;
    }
    List<Map<String, Object>> scripts = scriptsForExecution(plan.orderedScriptIds);
    String runName = "[Scheduled] " + str(schedule.get("name")) + " - " + Instant.now().toString().replace('T', ' ').substring(0, 19);
    String xml = buildTestNgXml(runName, scripts);
    int userId = intValue(schedule.get("createdBy"), 1);
    Map<String, Object> created = db.one("INSERT INTO execution_runs (run_name, run_type, status, total_scripts, environment, config_xml, triggered_by, started_at) VALUES (?, ?::run_type, 'running'::run_status, ?, ?, ?, ?, NOW()) RETURNING id",
        runName, scripts.size() == 1 ? "single" : "custom", scripts.size(), schedule.getOrDefault("environment", "local"), xml, userId);
    int runId = intValue(created.get("id"), 0);
    for (Map<String, Object> script : scripts) db.update("INSERT INTO execution_results (run_id, script_id, status) VALUES (?, ?, 'queued'::result_status)", runId, script.get("id"));
    if (Boolean.TRUE.equals(schedule.get("isOneTime"))) {
      db.update("UPDATE scheduled_runs SET last_run_at = NOW(), next_run_at = NULL, is_active = FALSE WHERE id = ?", scheduleId);
    } else {
      db.update("UPDATE scheduled_runs SET last_run_at = NOW(), next_run_at = ? WHERE id = ?", nextRunAt(str(schedule.get("cronExpression")), false), scheduleId);
    }
    db.update("INSERT INTO app_logs (severity, module, action, status, message, metadata) VALUES ('INFO', 'scheduler', 'SCHEDULED_RUN_TRIGGERED', 'SUCCESS', ?, ?::jsonb)",
        "Scheduled run \"" + str(schedule.get("name")) + "\" triggered. Run ID: " + runId, json(Map.of("scheduleId", scheduleId, "runId", runId, "scriptCount", scripts.size())));
    startExecution(runId, runName, xml, scripts);
  }

}
