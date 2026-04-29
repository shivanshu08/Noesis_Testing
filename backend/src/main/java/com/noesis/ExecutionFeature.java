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
import java.util.Map;
import jakarta.mail.MessagingException;

class ExecutionFeature extends SuiteManagementFeature {
  protected void run(HttpExchange ex, Auth auth) throws IOException, SQLException {
    edit(auth);
    Map<String, Object> b = body(ex);
    List<Integer> ids = intList(b.get("scriptIds"));
    if (ids.isEmpty()) throw new ApiException(400, "At least one script ID is required.");
    if ("tester".equals(auth.role) && !hasAssignedScripts(auth.userId, ids)) {
      throw new ApiException(403, "Access denied: One or more scripts are not assigned to you.");
    }
    List<Integer> expandedIds = resolveScriptExecutionPlan(ids);
    if (expandedIds.isEmpty()) throw new ApiException(400, "At least one valid script ID is required.");
    List<Map<String, Object>> scripts = db.rows("SELECT id, name, class_name, method_name FROM scripts WHERE is_active = TRUE AND id IN (" + placeholders(expandedIds.size()) + ") ORDER BY name", expandedIds.toArray());
    if (scripts.isEmpty()) throw new ApiException(400, "No valid active scripts found.");
    String runName = str(b.get("suiteName")).isBlank() ? "Run " + Instant.now().toString().replace('T', ' ').substring(0, 19) : str(b.get("suiteName"));
    String xml = buildTestNgXml(runName, scripts);
    Map<String, Object> created = db.one("INSERT INTO execution_runs (run_name, run_type, status, total_scripts, environment, config_xml, triggered_by, started_at) VALUES (?, ?::run_type, 'running'::run_status, ?, ?, ?, ?, NOW()) RETURNING id",
        runName, scripts.size() == 1 ? "single" : "custom", scripts.size(), b.getOrDefault("environment", "local"), xml, auth.userId);
    int runId = intValue(created.get("id"), 0);
    for (Map<String, Object> script : scripts) db.update("INSERT INTO execution_results (run_id, script_id, status) VALUES (?, ?, 'queued'::result_status)", runId, script.get("id"));
    db.update("UPDATE users SET run_count = COALESCE(run_count, 0) + 1 WHERE id = ?", auth.userId);
    startExecution(runId, runName, xml, scripts);
    List<Integer> autoIncluded = expandedIds.stream().filter(id -> !ids.contains(id)).toList();
    send(ex, 201, Map.of("runId", runId, "message", "Execution started.", "totalScripts", scripts.size(), "resolvedScriptIds", expandedIds, "autoIncludedDependencyIds", autoIncluded));
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
    List<Object> params = new ArrayList<>();
    String where = "WHERE 1=1";
    if (q.containsKey("status") && !q.get("status").isBlank()) { where += " AND er.status = ?::run_status"; params.add(q.get("status")); }
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
    Map<String, Object> run = db.one("SELECT er.*, u.full_name AS triggered_by_name FROM execution_runs er LEFT JOIN users u ON er.triggered_by = u.id WHERE er.id = ?", id);
    if (run == null) throw new ApiException(404, "Run not found.");
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
    Object[] userParam = new Object[]{};
    String runFilter = "";
    String andOrWhere = runFilter.isBlank() ? " WHERE " : " AND ";
    Object[] historyParams = new Object[]{};
    boolean tester = "tester".equals(auth.role);

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
    List<Map<String, Object>> rows = artifactRows(runId);
    List<Map<String, Object>> visible = visibleArtifacts(runId, rows);
    if (visible.isEmpty()) {
      ensureOutputArtifactsForRun(runId);
      visible = visibleArtifacts(runId, artifactRows(runId));
    }
    send(ex, 200, visible);
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

    try {
      sendMail(recipients, str(b.getOrDefault("subject", "Noesis artifacts for Run #" + runId)),
          str(b.getOrDefault("message", "Please find the selected execution artifacts attached.")), artifacts);
      send(ex, 200, Map.of("message", "Selected artifacts were mailed successfully.", "artifactCount", artifacts.size(), "recipientCount", recipients.size()));
    } catch (MessagingException e) {
      throw new ApiException(502, "Mail failed: " + e.getMessage());
    }
  }

  protected void globalLogs(HttpExchange ex, Map<String, String> q) throws IOException, SQLException {
    int limit = Integer.parseInt(q.getOrDefault("limit", "200"));
    int offset = Integer.parseInt(q.getOrDefault("offset", "0"));
    Number total = (Number) db.one("SELECT COUNT(*)::int AS count FROM app_logs").get("count");
    send(ex, 200, Map.of("data", db.rows("SELECT * FROM app_logs ORDER BY timestamp DESC LIMIT ? OFFSET ?", limit, offset), "summary", Map.of("total", total), "meta", Map.of("total", total, "limit", limit, "offset", offset)));
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
    boolean oneTime = Boolean.TRUE.equals(b.getOrDefault("isOneTime", false));
    Object nextRunAt = nextRunAt(str(b.get("cronExpression")), oneTime);
    Map<String, Object> created = db.one("INSERT INTO scheduled_runs (name, suite_id, script_ids, cron_expression, environment, description, is_one_time, next_run_at, created_by) VALUES (?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?) RETURNING *",
        b.get("name"), b.get("suiteId"), b.containsKey("scriptIds") ? json(b.get("scriptIds")) : null, b.get("cronExpression"), b.getOrDefault("environment", "local"), b.get("description"), oneTime, nextRunAt, auth.userId);
    send(ex, 201, created);
  }

  protected void schedules(HttpExchange ex) throws IOException, SQLException {
    send(ex, 200, db.rows("SELECT sr.*, u.full_name AS created_by_name FROM scheduled_runs sr LEFT JOIN users u ON sr.created_by = u.id ORDER BY sr.created_at DESC"));
  }

  protected void updateSchedule(HttpExchange ex, int id) throws IOException, SQLException {
    Map<String, Object> b = body(ex);
    Object nextRunAt = b.containsKey("cronExpression") || b.containsKey("isOneTime")
        ? nextRunAt(str(b.get("cronExpression")), Boolean.TRUE.equals(b.getOrDefault("isOneTime", false)))
        : null;
    db.update("UPDATE scheduled_runs SET name = COALESCE(?, name), cron_expression = COALESCE(?, cron_expression), is_active = COALESCE(?, is_active), environment = COALESCE(?, environment), description = COALESCE(?, description), is_one_time = COALESCE(?, is_one_time), next_run_at = COALESCE(?, next_run_at) WHERE id = ?",
        b.get("name"), b.get("cronExpression"), b.get("isActive"), b.get("environment"), b.get("description"), b.get("isOneTime"), nextRunAt, id);
    send(ex, 200, message("Schedule updated."));
  }

  protected void deleteSchedule(HttpExchange ex, int id) throws IOException, SQLException {
    db.update("DELETE FROM scheduled_runs WHERE id = ?", id);
    send(ex, 200, message("Schedule deleted."));
  }

}
