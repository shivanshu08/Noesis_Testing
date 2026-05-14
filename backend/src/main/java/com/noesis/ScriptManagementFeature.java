package com.noesis;


import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

class ScriptManagementFeature extends ExecutionSupportFeature {
  protected void scripts(HttpExchange ex, Auth auth, Map<String, String> q) throws IOException, SQLException {
    ensureDependencies();
    List<Object> params = new ArrayList<>();
    StringBuilder sql = new StringBuilder("""
        SELECT s.*, sc.name AS category_name, sc.icon AS category_icon, sc.color AS category_color,
          COALESCE(sa.assigned_user_count, 0)::int AS assigned_user_count,
          COALESCE(sa.assigned_users, '[]'::json) AS assigned_users,
          COALESCE(dep.dependency_count, 0)::int AS dependency_count,
          COALESCE(dep2.dependent_count, 0)::int AS dependent_count,
          COALESCE(dep.dependency_ids, ARRAY[]::int[]) AS dependencies
        FROM scripts s
        JOIN script_categories sc ON s.category_id = sc.id
        LEFT JOIN (
          SELECT sa.script_id, COUNT(u.id)::int assigned_user_count,
            json_agg(json_build_object('id', u.id, 'username', u.username, 'fullName', u.full_name, 'role', u.role) ORDER BY u.username) AS assigned_users
          FROM script_assignments sa JOIN users u ON u.id = sa.user_id
          GROUP BY sa.script_id
        ) sa ON sa.script_id = s.id
        LEFT JOIN (
          SELECT script_id, COUNT(*)::int dependency_count, ARRAY_AGG(dependency_script_id ORDER BY dependency_script_id)::int[] AS dependency_ids
          FROM script_dependencies GROUP BY script_id
        ) dep ON dep.script_id = s.id
        LEFT JOIN (SELECT dependency_script_id, COUNT(*)::int dependent_count FROM script_dependencies GROUP BY dependency_script_id) dep2 ON dep2.dependency_script_id = s.id
        WHERE 1=1
        """);
    if (q.containsKey("active")) {
      sql.append(" AND s.is_active = ?");
      params.add(Boolean.parseBoolean(q.get("active")));
    } else sql.append(" AND s.is_active = TRUE");
    if (q.containsKey("category")) {
      sql.append(" AND s.category_id = ?");
      params.add(Integer.parseInt(q.get("category")));
    }
    if (q.containsKey("search") && !q.get("search").isBlank()) {
      sql.append(" AND (s.name ILIKE ? OR s.class_name ILIKE ? OR COALESCE(s.description,'') ILIKE ?)");
      String term = "%" + q.get("search") + "%";
      params.add(term); params.add(term); params.add(term);
    }
    if ("tester".equals(auth.role)) {
      sql.append(" AND s.id IN (SELECT script_id FROM script_assignments WHERE user_id = ?)");
      params.add(auth.userId);
    }
    sql.append(" ORDER BY s.name");
    List<Map<String, Object>> rows = db.rows(sql.toString(), params.toArray());
    addFlakyMetrics(rows);
    addLastRunSummaries(rows);
    send(ex, 200, rows);
  }

  protected void categories(HttpExchange ex, Auth auth) throws IOException, SQLException {
    boolean tester = "tester".equals(auth.role);
    send(ex, 200, db.rows("""
        SELECT sc.*, COALESCE(COUNT(s.id), 0)::int AS script_count
        FROM script_categories sc
        LEFT JOIN scripts s ON s.category_id = sc.id AND s.is_active = TRUE
          """ + (tester ? "AND s.id IN (SELECT script_id FROM script_assignments WHERE user_id = ?) " : "") + """
        GROUP BY sc.id ORDER BY sc.sort_order, sc.name
        """, tester ? new Object[]{auth.userId} : new Object[]{}));
  }

  protected void script(HttpExchange ex, int id) throws IOException, SQLException {
    Map<String, Object> row = db.one("""
        SELECT s.*, sc.name AS category_name, sc.icon AS category_icon, sc.color AS category_color
        FROM scripts s JOIN script_categories sc ON s.category_id = sc.id WHERE s.id = ?
        """, id);
    if (row == null) throw new ApiException(404, "Script not found.");
    row.put("dependencies", dependencyIds(id));
    row.put("assignedUsers", db.rows("""
        SELECT u.id, u.username, u.full_name FROM script_assignments sa
        JOIN users u ON u.id = sa.user_id WHERE sa.script_id = ? ORDER BY u.username
        """, id));
    send(ex, 200, row);
  }

  protected void updateScript(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    edit(auth);
    Map<String, Object> b = body(ex);
    db.update("""
        UPDATE scripts SET name = COALESCE(?, name), description = COALESCE(?, description),
          category_id = COALESCE(?, category_id), method_name = COALESCE(?, method_name),
          config_file = COALESCE(?, config_file), tags = COALESCE(?::jsonb, tags),
          is_active = COALESCE(?, is_active), updated_at = NOW() WHERE id = ?
        """, b.get("name"), b.get("description"), b.get("categoryId"), b.get("methodName"), b.get("configFile"),
        b.containsKey("tags") ? json(b.get("tags")) : null, b.get("isActive"), id);
    send(ex, 200, message("Script updated."));
  }

  protected void updateScriptDependencies(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    edit(auth);
    requireScriptAccess(auth, id);
    ensureDependencies();
    List<Integer> ids = intList(body(ex).get("dependencyIds")).stream().filter(dep -> dep != id).distinct().toList();
    if ("tester".equals(auth.role) && !hasAssignedScripts(auth.userId, ids)) {
      throw new ApiException(403, "Access denied: One or more dependency scripts are not assigned to you.");
    }
    if (!ids.isEmpty()) {
      int active = intValue(db.one("SELECT COUNT(*)::int AS count FROM scripts WHERE is_active = TRUE AND id IN (" + placeholders(ids.size()) + ")", ids.toArray()).get("count"), 0);
      if (active != ids.size()) throw new ApiException(400, "Inactive scripts cannot be added as dependencies.");
    }
    List<Integer> cycle = dependencyCycleFor(id, ids);
    if (!cycle.isEmpty()) throw new ApiException(400, "Dependency cycle detected. Remove circular links before saving. Path: " + cycle);
    db.update("DELETE FROM script_dependencies WHERE script_id = ?", id);
    for (Integer dep : ids) if (dep != id) db.update("INSERT INTO script_dependencies (script_id, dependency_script_id) VALUES (?, ?) ON CONFLICT DO NOTHING", id, dep);
    send(ex, 200, Map.of("message", "Script dependencies updated.", "scriptId", id, "dependencyIds", ids));
  }

  protected List<Integer> dependencyCycleFor(int scriptId, List<Integer> proposedDependencies) throws SQLException {
    Map<Integer, List<Integer>> graph = new LinkedHashMap<>();
    for (Map<String, Object> row : db.rows("SELECT script_id, dependency_script_id FROM script_dependencies WHERE script_id <> ?", scriptId)) {
      int from = intValue(row.get("scriptId"), 0);
      int to = intValue(row.get("dependencyScriptId"), 0);
      if (from > 0 && to > 0) graph.computeIfAbsent(from, k -> new ArrayList<>()).add(to);
    }
    graph.put(scriptId, proposedDependencies);
    List<Integer> stack = new ArrayList<>();
    return findDependencyCycle(scriptId, graph, stack, new LinkedHashSet<>());
  }

  protected List<Integer> findDependencyCycle(int node, Map<Integer, List<Integer>> graph, List<Integer> stack, LinkedHashSet<Integer> done) {
    if (stack.contains(node)) {
      List<Integer> cycle = new ArrayList<>(stack.subList(stack.indexOf(node), stack.size()));
      cycle.add(node);
      return cycle;
    }
    if (done.contains(node)) return List.of();
    stack.add(node);
    for (Integer next : graph.getOrDefault(node, List.of())) {
      List<Integer> cycle = findDependencyCycle(next, graph, stack, done);
      if (!cycle.isEmpty()) return cycle;
    }
    stack.remove(stack.size() - 1);
    done.add(node);
    return List.of();
  }

  protected void deleteScript(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    edit(auth);
    db.update("UPDATE scripts SET is_active = FALSE WHERE id = ?", id);
    send(ex, 200, message("Script deleted."));
  }

  protected void deleteScripts(HttpExchange ex, Auth auth) throws IOException, SQLException {
    edit(auth);
    List<Integer> ids = intList(body(ex).get("ids"));
    if (!ids.isEmpty()) db.update("UPDATE scripts SET is_active = FALSE WHERE id IN (" + placeholders(ids.size()) + ")", ids.toArray());
    send(ex, 200, Map.of("success", true, "deleted", ids.size()));
  }

  protected void syncScripts(HttpExchange ex, Auth auth) throws IOException, SQLException {
    admin(auth);
    Path root;
    try {
      root = resolveSyncWorkspace();
    } catch (Exception e) {
      throw new ApiException(500, "Failed to prepare automation workspace: " + e.getMessage());
    }
    if (!Files.isDirectory(root)) throw new ApiException(404, "Automation workspace not found: " + root);

    Object categoryId = db.one("SELECT id FROM script_categories ORDER BY sort_order, id LIMIT 1").get("id");
    List<String> added = new ArrayList<>();
    List<String> updated = new ArrayList<>();
    List<String> removed = new ArrayList<>();
    List<String> skipped = new ArrayList<>();
    LinkedHashSet<String> seenPaths = new LinkedHashSet<>();

    for (Path file : javaFiles(root)) {
      String fileName = file.getFileName().toString();
      try {
        String source = Files.readString(file);
        if (isConfigJava(fileName, source)) continue;
        String className = className(source, fileName);
        String relPath = root.relativize(file).toString().replace('\\', '/');
        String name = fileName.replaceFirst("(?i)\\.java$", "");
        seenPaths.add(relPath.toLowerCase(Locale.ROOT));
        Map<String, Object> existing = db.one("SELECT id FROM scripts WHERE LOWER(file_path) = LOWER(?) OR LOWER(class_name) = LOWER(?) ORDER BY is_active DESC, id LIMIT 1", relPath, className);
        if (existing == null) {
          db.update("INSERT INTO scripts (name, class_name, category_id, file_path, is_active) VALUES (?, ?, ?, ?, TRUE)", name, className, categoryId, relPath);
          added.add(name);
        } else {
          db.update("UPDATE scripts SET name = ?, class_name = ?, category_id = COALESCE(category_id, ?), file_path = ?, is_active = TRUE, updated_at = NOW() WHERE id = ?",
              name, className, categoryId, relPath, existing.get("id"));
          updated.add(name);
        }
      } catch (Exception e) {
        skipped.add(fileName + ": " + e.getMessage());
      }
    }

    for (Map<String, Object> script : db.rows("SELECT id, name, file_path FROM scripts WHERE is_active = TRUE")) {
      String fp = str(script.get("filePath")).toLowerCase(Locale.ROOT).replace('\\', '/');
      if (!fp.isBlank() && !seenPaths.contains(fp)) {
        db.update("UPDATE scripts SET is_active = FALSE, updated_at = NOW() WHERE id = ?", script.get("id"));
        removed.add(str(script.get("name")));
      }
    }
    send(ex, 200, Map.of("message", "Sync completed successfully",
        "stats", Map.of("added", added.size(), "updated", updated.size(), "removed", removed.size(), "skipped", skipped.size()),
        "details", Map.of("added", added, "updated", updated, "removed", removed, "skipped", skipped)));
  }

  protected void importScript(HttpExchange ex, Auth auth) throws IOException, SQLException {
    edit(auth);
    MultipartFile file = multipartFile(ex);
    if (file == null || !file.fileName.toLowerCase(Locale.ROOT).endsWith(".java")) throw new ApiException(400, "Only .java files are supported.");
    Path base = Path.of(env.value("ST_AUTOMATION_IMPORT_PATH", "automation-scripts"));
    Files.createDirectories(base);
    String source = new String(file.bytes, StandardCharsets.UTF_8);
    String className = className(source, file.fileName);
    String relPath = file.fileName;
    if (db.one("SELECT id FROM scripts WHERE is_active = TRUE AND (LOWER(file_path)=LOWER(?) OR LOWER(class_name)=LOWER(?))", relPath, className) != null) {
      throw new ApiException(409, "Duplicate script import is not allowed. The script is already registered.");
    }
    Files.write(base.resolve(file.fileName), file.bytes);
    Object categoryId = db.one("SELECT id FROM script_categories ORDER BY sort_order LIMIT 1").get("id");
    String name = file.fileName.replaceFirst("(?i)\\.java$", "");
    Map<String, Object> created = db.one("INSERT INTO scripts (name, class_name, category_id, file_path, is_active) VALUES (?, ?, ?, ?, TRUE) RETURNING id", name, className, categoryId, relPath);
    send(ex, 201, Map.of("message", "Script imported successfully", "action", "created", "script", Map.of("id", created.get("id"), "name", name, "className", className, "filePath", relPath, "categoryId", categoryId)));
  }

  protected void scriptConfiguration(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    requireScriptAccess(auth, id);
    Map<String, Object> row = db.one("""
        SELECT s.*, sc.name AS category_name, sc.icon AS category_icon, sc.color AS category_color, u.full_name AS created_by_name
        FROM scripts s
        JOIN script_categories sc ON s.category_id = sc.id
        LEFT JOIN users u ON u.id = s.created_by
        WHERE s.id = ?
        """, id);
    if (row == null) throw new ApiException(404, "Script not found.");
    Path path = resolveScriptPath(row.get("filePath"));
    boolean sourceAvailable = Files.exists(path) && Files.isRegularFile(path);
    List<String> lines = sourceAvailable ? Files.readAllLines(path) : List.of();
    String source = String.join("\n", lines);
    Map<String, Object> java = new LinkedHashMap<>();
    java.put("packageName", packageName(source));
    java.put("imports", lines.stream().filter(l -> l.trim().startsWith("import ")).toList());
    java.put("annotations", lines.stream().map(String::trim).filter(l -> l.startsWith("@")).toList());
    List<String> testMethods = javaTestMethods(source);
    java.put("methods", javaMethods(source));
    java.put("testMethods", testMethods);
    java.put("previewLines", lines.stream().limit(80).toList());
    java.put("lineCount", lines.size());
    java.put("fileSizeBytes", sourceAvailable ? Files.size(path) : 0);
    java.put("lastModifiedAt", sourceAvailable ? Files.getLastModifiedTime(path).toInstant().toString() : null);
    java.put("sourceAvailable", sourceAvailable);
    java.put("sourceReadError", sourceAvailable ? null : "Script file is not available on disk for path \"" + str(row.get("filePath")) + "\".");
    row.put("resolvedFilePath", path.toString());
    row.put("createdBy", row.get("createdByName"));
    String configuredMethod = str(row.get("methodName")).trim();
    String logicalMethod = !testMethods.isEmpty() && !testMethods.contains(configuredMethod)
        ? testMethods.get(0)
        : firstNonBlank(configuredMethod, inferPrimaryMethod(source), "-");
    row.put("methodName", logicalMethod);
    Map<String, Object> execution = scriptExecutionSummary(id);
    Map<String, List<Map<String, Object>>> resources = scriptResources(row, path, source);
    List<Map<String, Object>> editableFiles = editableFiles(resources, path, sourceAvailable);
    send(ex, 200, Map.of(
        "script", row,
        "java", java,
        "resources", resources,
        "editableFiles", editableFiles,
        "execution", execution,
        "recentFileChanges", List.of(),
        "artifacts", scriptArtifacts(id),
        "generatedAt", Instant.now().toString()));
  }

  protected Map<String, Object> scriptExecutionSummary(int scriptId) throws SQLException {
    Map<String, Object> summary = db.one("""
        SELECT
          COUNT(*)::int AS total_runs,
          COUNT(*) FILTER (WHERE eres.status = 'passed')::int AS passed_runs,
          COUNT(*) FILTER (WHERE eres.status = 'failed')::int AS failed_runs,
          COUNT(*) FILTER (WHERE eres.status = 'error')::int AS error_runs,
          COUNT(*) FILTER (WHERE eres.status = 'skipped')::int AS skipped_runs,
          ROUND(AVG(NULLIF(eres.duration_ms, 0)))::bigint AS average_script_duration_ms,
          COUNT(DISTINCT er.triggered_by)::int AS unique_executors
        FROM execution_results eres
        JOIN execution_runs er ON er.id = eres.run_id
        WHERE eres.script_id = ?
        """, scriptId);
    int total = intValue(summary.get("totalRuns"), 0);
    int passed = intValue(summary.get("passedRuns"), 0);
    int skipped = intValue(summary.get("skippedRuns"), 0);
    List<Map<String, Object>> recentRuns = db.rows("""
        SELECT
          er.id AS run_id,
          er.id,
          er.run_name,
          er.status AS run_status,
          eres.status AS result_status,
          er.environment,
          er.run_metadata,
          er.started_at,
          er.completed_at,
          er.duration_ms AS run_duration_ms,
          eres.duration_ms AS script_duration_ms,
          COALESCE(u.full_name, u.username, 'System') AS triggered_by
        FROM execution_results eres
        JOIN execution_runs er ON er.id = eres.run_id
        LEFT JOIN users u ON u.id = er.triggered_by
        WHERE eres.script_id = ?
        ORDER BY er.started_at DESC NULLS LAST, er.created_at DESC
        LIMIT 15
        """, scriptId);
    for (Map<String, Object> run : recentRuns) {
      run.put("runMetadata", enrichRunMetadata(run));
      run.remove("id");
    }
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("totalRuns", total);
    out.put("passedRuns", passed);
    out.put("failedRuns", intValue(summary.get("failedRuns"), 0));
    out.put("errorRuns", intValue(summary.get("errorRuns"), 0));
    out.put("skippedRuns", skipped);
    out.put("passRate", percent(passed, total));
    out.put("stabilityScore", total > 0 ? percent(passed + (skipped * 0.25), total) : 0);
    out.put("uniqueExecutors", intValue(summary.get("uniqueExecutors"), 0));
    out.put("averageScriptDurationMs", summary.get("averageScriptDurationMs"));
    out.put("lastRun", recentRuns.isEmpty() ? null : recentRuns.get(0));
    out.put("recentRuns", recentRuns);
    return out;
  }

  protected void addFlakyMetrics(List<Map<String, Object>> scripts) throws SQLException {
    List<Integer> ids = scripts.stream()
        .map(row -> metricScriptId(row))
        .filter(id -> id > 0)
        .distinct()
        .toList();
    if (ids.isEmpty()) return;

    List<Map<String, Object>> rows = db.rows("""
        SELECT script_id, status
        FROM (
          SELECT
            eres.script_id,
            eres.status::text AS status,
            ROW_NUMBER() OVER (
              PARTITION BY eres.script_id
              ORDER BY COALESCE(eres.completed_at, er.completed_at, er.started_at, er.created_at) DESC, eres.id DESC
            ) AS rn
          FROM execution_results eres
          JOIN execution_runs er ON er.id = eres.run_id
          WHERE eres.script_id IN (""" + placeholders(ids.size()) + """
            ) AND eres.status IN ('passed'::result_status, 'failed'::result_status, 'error'::result_status)
        ) recent
        WHERE rn <= 10
        ORDER BY script_id, rn
        """, ids.toArray());

    Map<Integer, List<String>> statusesByScript = new LinkedHashMap<>();
    for (Map<String, Object> row : rows) {
      int scriptId = intValue(row.get("scriptId"), 0);
      if (scriptId <= 0) continue;
      statusesByScript.computeIfAbsent(scriptId, ignored -> new ArrayList<>()).add(str(row.get("status")).toLowerCase(Locale.ROOT));
    }

    for (Map<String, Object> script : scripts) {
      int scriptId = metricScriptId(script);
      List<String> statuses = statusesByScript.getOrDefault(scriptId, List.of());
      int total = statuses.size();
      int passed = (int) statuses.stream().filter("passed"::equals).count();
      int failed = (int) statuses.stream().filter(status -> "failed".equals(status) || "error".equals(status)).count();
      int transitions = 0;
      String previous = "";
      for (String status : statuses) {
        String bucket = "passed".equals(status) ? "passed" : "failed";
        if (!previous.isBlank() && !previous.equals(bucket)) transitions++;
        previous = bucket;
      }
      int failureRate = percent(failed, total);
      boolean flaky = total >= 4 && passed > 0 && failed > 0 && (transitions >= 2 || (failureRate >= 20 && failureRate <= 80));
      script.put("recentRunCount", total);
      script.put("recentPassedCount", passed);
      script.put("recentFailedCount", failed);
      script.put("recentFailureRate", failureRate);
      script.put("flakyScore", flaky ? Math.min(100, (transitions * 20) + Math.abs(50 - Math.abs(50 - failureRate))) : 0);
      script.put("isFlaky", flaky);
    }
  }

  protected void addLastRunSummaries(List<Map<String, Object>> scripts) throws SQLException {
    List<Integer> ids = scripts.stream()
        .map(row -> metricScriptId(row))
        .filter(id -> id > 0)
        .distinct()
        .toList();
    if (ids.isEmpty()) return;

    List<Map<String, Object>> rows = db.rows("""
        SELECT script_id, status, completed_at, started_at, created_at
        FROM (
          SELECT
            eres.script_id,
            eres.status::text AS status,
            er.completed_at,
            er.started_at,
            er.created_at,
            ROW_NUMBER() OVER (
              PARTITION BY eres.script_id
              ORDER BY COALESCE(eres.completed_at, er.completed_at, er.started_at, er.created_at) DESC, eres.id DESC
            ) AS rn
          FROM execution_results eres
          JOIN execution_runs er ON er.id = eres.run_id
          WHERE eres.script_id IN (""" + placeholders(ids.size()) + """
            ) AND eres.status IN ('passed'::result_status, 'failed'::result_status, 'error'::result_status, 'skipped'::result_status)
        ) recent
        WHERE rn = 1
        """, ids.toArray());

    Map<Integer, Map<String, Object>> byScript = new LinkedHashMap<>();
    for (Map<String, Object> row : rows) byScript.put(intValue(row.get("scriptId"), 0), row);
    for (Map<String, Object> script : scripts) {
      Map<String, Object> last = byScript.get(metricScriptId(script));
      if (last == null) continue;
      script.put("lastRunStatus", last.get("status"));
      script.put("lastRunAt", firstNonBlank(str(last.get("completedAt")), str(last.get("startedAt")), str(last.get("createdAt"))));
    }
  }

  protected int metricScriptId(Map<String, Object> row) {
    int scriptId = intValue(row.get("scriptId"), 0);
    return scriptId > 0 ? scriptId : intValue(row.get("id"), 0);
  }

  protected int percent(double numerator, double denominator) {
    if (denominator <= 0) return 0;
    return (int) Math.round((numerator / denominator) * 100.0);
  }

  protected List<Map<String, Object>> scriptArtifacts(int scriptId) throws SQLException {
    return db.rows("""
        SELECT
          ea.id, ea.run_id, ea.artifact_type, ea.file_name, ea.stored_path, ea.file_size_bytes, ea.mime_type,
          ea.created_at, er.run_name, er.status AS run_status, er.started_at AS run_started_at
        FROM execution_artifacts ea
        LEFT JOIN execution_runs er ON er.id = ea.run_id
        WHERE ea.script_id = ?
        ORDER BY ea.created_at DESC
        LIMIT 30
        """, scriptId);
  }

  protected Map<String, List<Map<String, Object>>> scriptResources(Map<String, Object> script, Path scriptPath, String source) {
    List<Map<String, Object>> javaConfigs = new ArrayList<>();
    List<Map<String, Object>> jsonFiles = new ArrayList<>();
    List<Map<String, Object>> attachments = new ArrayList<>();
    List<Map<String, Object>> dataFiles = new ArrayList<>();
    Path workspace = automationWorkspace();

    if (scriptPath != null) {
      javaConfigs.add(resource("java_config", scriptPath.getFileName().toString(), scriptPath, Files.exists(scriptPath), "Script Java File"));
    }

    List<Map<String, Object>> scriptJavaConfigs = new ArrayList<>();
    for (String imp : javaImports(source)) {
      String simple = imp.substring(imp.lastIndexOf('.') + 1);
      Path resolved = resolveImportPath(workspace, imp);
      if (resolved == null) continue;
      if (isBaseConfigImport(simple)) {
        continue;
      }
      if (!isScriptJavaConfigImport(simple)) continue;
      scriptJavaConfigs.add(resource("java_config", imp, resolved, Files.exists(resolved), "Script Java Config file"));
    }

    collectReferencedResources(source, scriptPath, workspace, jsonFiles, attachments, "script json", false);
    for (Map<String, Object> javaConfig : scriptJavaConfigs) {
      Path configPath = javaConfig.get("resolvedPath") == null ? null : Path.of(str(javaConfig.get("resolvedPath")));
      if (configPath == null || !Files.exists(configPath)) continue;
      try {
        collectReferencedResources(Files.readString(configPath), configPath, workspace, jsonFiles, attachments, "script json", true);
      } catch (Exception ignored) {}
    }
    javaConfigs.addAll(scriptJavaConfigs);

    Object configFile = script.get("configFile");
    if (isJsonReference(str(configFile))) {
      Path resolved = resolveResourceReference(scriptPath, workspace, str(configFile));
      Map<String, Object> item = resource("json", str(configFile), resolved, resolved != null && Files.exists(resolved), "script json");
      jsonFiles.add(item);
    }
    for (Map<String, Object> jsonFile : jsonFiles) {
      Path jsonPath = jsonFile.get("resolvedPath") == null ? null : Path.of(str(jsonFile.get("resolvedPath")));
      if (jsonPath == null || !Files.exists(jsonPath)) continue;
      collectJsonAttachments(jsonPath, workspace, attachments);
    }

    return Map.of(
        "javaConfigs", dedupeResources(javaConfigs),
        "jsonFiles", dedupeResources(jsonFiles),
        "attachments", dedupeResources(attachments),
        "dataFiles", dedupeResources(dataFiles));
  }

  protected boolean isBaseConfigImport(String simpleName) {
    return "baseconfig".equalsIgnoreCase(simpleName);
  }

  protected boolean isScriptJavaConfigImport(String simpleName) {
    String lower = simpleName == null ? "" : simpleName.toLowerCase(Locale.ROOT);
    return lower.contains("config")
        && !"baseconfig".equals(lower)
        && !"htmlpath".equals(lower)
        && !lower.contains("common");
  }

  protected void collectReferencedResources(String source, Path contextPath, Path workspace, List<Map<String, Object>> jsonFiles, List<Map<String, Object>> attachments, String jsonLogicalName, boolean includeJson) {
    Matcher strings = Pattern.compile("\"([^\"]+\\.[a-zA-Z0-9]{1,8})\"", Pattern.CASE_INSENSITIVE).matcher(source == null ? "" : source);
    while (strings.find()) {
      String ref = strings.group(1);
      if (!looksLikeFileReference(ref)) continue;
      Path resolved = resolveResourceReference(contextPath, workspace, ref);
      String type = isJsonReference(ref) ? "json" : "attachment";
      if (type.equals("json") && !includeJson) continue;
      Map<String, Object> item = resource(type, ref, resolved, resolved != null && Files.exists(resolved), type.equals("json") ? jsonLogicalName : "Attachment");
      if (type.equals("json")) jsonFiles.add(item); else attachments.add(item);
    }
  }

  protected boolean isJsonReference(String value) {
    return value != null && value.trim().toLowerCase(Locale.ROOT).endsWith(".json");
  }

  protected void collectJsonAttachments(Path jsonPath, Path workspace, List<Map<String, Object>> attachments) {
    try {
      Object root = JSON.readValue(Files.readString(jsonPath), ANY);
      collectJsonAttachmentValues(root, "", jsonPath, workspace, attachments);
    } catch (Exception ignored) {}
  }

  protected void collectJsonAttachmentValues(Object value, String key, Path jsonPath, Path workspace, List<Map<String, Object>> attachments) {
    if (value instanceof Map<?, ?> map) {
      for (Map.Entry<?, ?> entry : map.entrySet()) collectJsonAttachmentValues(entry.getValue(), str(entry.getKey()), jsonPath, workspace, attachments);
      return;
    }
    if (value instanceof Iterable<?> iterable) {
      for (Object item : iterable) collectJsonAttachmentValues(item, key, jsonPath, workspace, attachments);
      return;
    }
    if (!(value instanceof String text)) return;
    String ref = text.trim();
    if (ref.isBlank() || isUrlOrEmail(ref) || ref.contains("${")) return;

    if (shouldResolveAsFolder(key, ref)) {
      Path folder = resolveDirectoryReference(jsonPath, workspace, ref);
      if (folder != null && Files.isDirectory(folder)) {
        addFolderAttachments(ref, folder, attachments);
      } else {
        attachments.add(resource("attachment", ref, folder, false, "JSON Attachment Folder"));
      }
      return;
    }

    if (!looksLikeFileReference(ref)) return;
    Path resolved = resolveResourceReference(jsonPath, workspace, ref);
    attachments.add(resource("attachment", ref, resolved, resolved != null && Files.isRegularFile(resolved), "JSON Attachment"));
  }

  protected boolean shouldResolveAsFolder(String key, String value) {
    String lowerKey = key == null ? "" : key.toLowerCase(Locale.ROOT);
    String lowerValue = value == null ? "" : value.toLowerCase(Locale.ROOT);
    return lowerValue.endsWith("/") || lowerValue.endsWith("\\")
        || lowerKey.contains("folder")
        || lowerKey.contains("directory")
        || lowerKey.contains("location")
        || lowerKey.contains("path");
  }

  protected void addFolderAttachments(String reference, Path folder, List<Map<String, Object>> attachments) {
    String prefix = reference.endsWith("/") || reference.endsWith("\\") ? reference : reference + "/";
    try (var stream = Files.walk(folder, 5)) {
      stream.filter(Files::isRegularFile)
          .forEach(path -> attachments.add(resource("attachment", prefix + folder.relativize(path), path, true, "JSON Folder File")));
    } catch (Exception ignored) {}
  }

  protected Path resolveDirectoryReference(Path contextPath, Path workspace, String reference) {
    if (reference == null || reference.isBlank()) return null;
    String cleaned = reference.replace("\\", File.separator).replace("/", File.separator);
    Path raw = Path.of(cleaned);
    List<Path> candidates = new ArrayList<>();
    if (raw.isAbsolute()) candidates.add(raw);
    if (contextPath != null && contextPath.getParent() != null) candidates.add(contextPath.getParent().resolve(raw));
    candidates.add(workspace.resolve(raw));
    candidates.add(workspace.resolve("src").resolve("test").resolve("resources").resolve(raw));
    candidates.add(workspace.resolve("src").resolve("main").resolve("resources").resolve(raw));
    String stripped = cleaned.replaceFirst("(?i)^src[\\\\/]main[\\\\/]resources[\\\\/]?", "")
        .replaceFirst("(?i)^src[\\\\/]test[\\\\/]resources[\\\\/]?", "");
    if (!stripped.equals(cleaned)) {
      Path strippedPath = Path.of(stripped);
      candidates.add(workspace.resolve("src").resolve("main").resolve("resources").resolve(strippedPath));
      candidates.add(workspace.resolve("src").resolve("test").resolve("resources").resolve(strippedPath));
    }
    for (Path candidate : candidates) if (Files.isDirectory(candidate)) return candidate;
    return null;
  }

  protected boolean looksLikeFileReference(String value) {
    if (value == null) return false;
    String trimmed = value.trim();
    if (trimmed.isBlank() || isUrlOrEmail(trimmed)) return false;
    String leaf = trimmed.replace('\\', '/');
    leaf = leaf.substring(leaf.lastIndexOf('/') + 1);
    Matcher fileName = Pattern.compile("^[^\\s]+\\.([A-Za-z0-9]{1,8})$").matcher(leaf);
    return fileName.matches() && Pattern.compile("[A-Za-z]").matcher(fileName.group(1)).find();
  }

  protected boolean isUrlOrEmail(String value) {
    String lower = value == null ? "" : value.toLowerCase(Locale.ROOT);
    return lower.contains("://") || lower.startsWith("mailto:") || lower.matches("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$");
  }

  protected List<Map<String, Object>> editableFiles(Map<String, List<Map<String, Object>>> resources, Path scriptPath, boolean scriptExists) {
    List<Map<String, Object>> files = new ArrayList<>();
    List<Map<String, Object>> coreResources = new ArrayList<>();
    coreResources.addAll(resources.getOrDefault("javaConfigs", List.of()));
    coreResources.addAll(resources.getOrDefault("jsonFiles", List.of()));
    coreResources.sort(Comparator.comparingInt(this::coreResourcePriority));
    for (Map<String, Object> resource : coreResources) {
      if (!Boolean.TRUE.equals(resource.get("existsOnDisk"))) continue;
      String path = str(resource.get("resolvedPath"));
      if (path.isBlank()) continue;
      String fileType = path.toLowerCase(Locale.ROOT).endsWith(".json") ? "json" : "java";
      files.add(editableFile(Path.of(path), fileType, str(resource.get("reference")), str(resource.get("type"))));
    }
    Map<String, Map<String, Object>> byPath = new LinkedHashMap<>();
    for (Map<String, Object> file : files) byPath.put(str(file.get("path")).toLowerCase(Locale.ROOT), file);
    return new ArrayList<>(byPath.values());
  }

  protected int coreResourcePriority(Map<String, Object> resource) {
    Object metadataValue = resource.get("metadata");
    String logicalName = metadataValue instanceof Map<?, ?> metadata ? str(metadata.get("logicalName")).toLowerCase(Locale.ROOT) : "";
    if ("script java file".equals(logicalName)) return 10;
    if ("script java config file".equals(logicalName)) return 20;
    if ("script json".equals(logicalName)) return 30;
    if ("base config".equals(logicalName)) return 40;
    return 100;
  }

  protected Map<String, Object> editableFile(Path path, String fileType, String reference, String sourceType) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("path", path.toString());
    out.put("fileType", fileType);
    out.put("reference", reference);
    out.put("sourceType", sourceType);
    out.put("existsOnDisk", Files.exists(path));
    try {
      out.put("fileSizeBytes", Files.size(path));
      out.put("lastModifiedAt", Files.getLastModifiedTime(path).toInstant().toString());
    } catch (Exception ignored) {}
    return out;
  }

  protected Map<String, Object> resource(String type, String reference, Path resolved, boolean exists, String logicalName) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("type", type);
    out.put("reference", reference);
    out.put("resolvedPath", resolved == null ? null : resolved.toString());
    out.put("existsOnDisk", exists);
    out.put("sourceKind", "parser");
    out.put("metadata", Map.of("logicalName", logicalName));
    return out;
  }

  protected List<Map<String, Object>> dedupeResources(List<Map<String, Object>> resources) {
    Map<String, Map<String, Object>> byKey = new LinkedHashMap<>();
    for (Map<String, Object> resource : resources) {
      String key = firstNonBlank(str(resource.get("resolvedPath")), str(resource.get("reference"))).toLowerCase(Locale.ROOT);
      if (!key.isBlank()) byKey.putIfAbsent(key, resource);
    }
    return new ArrayList<>(byKey.values());
  }

  protected void fileContent(HttpExchange ex, Map<String, String> q) throws IOException {
    Path path = Path.of(q.getOrDefault("path", ""));
    if (!Files.exists(path)) throw new ApiException(404, "File not found.");
    send(ex, 200, Map.of("path", path.toString(), "fileName", path.getFileName().toString(), "fileType", path.toString().endsWith(".json") ? "json" : "java", "fileSizeBytes", Files.size(path), "lastModifiedAt", Files.getLastModifiedTime(path).toInstant().toString(), "content", Files.readString(path)));
  }

  protected void updateFile(HttpExchange ex, Auth auth, int scriptId) throws IOException, SQLException {
    edit(auth);
    requireScriptAccess(auth, scriptId);
    Map<String, Object> b = body(ex);
    Path path = Path.of(str(b.get("path")));
    String before = Files.exists(path) ? Files.readString(path) : "";
    String content = str(b.get("content"));
    Files.writeString(path, content);
    Map<String, Object> summary = changeSummary(before, content);
    if (!before.equals(content)) {
      db.one("""
          INSERT INTO script_configuration_changes
            (script_id, file_path, file_name, file_type, changed_by, changed_by_user_id, change_summary, previous_content, updated_content)
          VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
          RETURNING id
          """,
          scriptId, path.toString(), path.getFileName().toString(),
          path.toString().toLowerCase(Locale.ROOT).endsWith(".json") ? "json" : "java",
          auth.username, auth.userId, json(summary), before, content);
    }
    send(ex, 200, Map.of(
        "message", before.equals(content) ? "No changes detected." : "File updated successfully.",
        "changed", !before.equals(content),
        "changeSummary", summary,
        "file", Map.of("path", path.toString(), "fileName", path.getFileName().toString(), "fileType", path.toString().endsWith(".json") ? "json" : "java")));
  }

  protected void configurationChanges(HttpExchange ex, Auth auth, int scriptId, Map<String, String> q) throws IOException, SQLException {
    requireScriptAccess(auth, scriptId);
    int limit = Math.max(1, Math.min(100, intValue(q.get("limit"), 40)));
    send(ex, 200, db.rows("""
        SELECT id, script_id, file_path, file_name, file_type, changed_by, changed_at, change_summary
        FROM script_configuration_changes
        WHERE script_id = ?
        ORDER BY changed_at DESC, id DESC
        LIMIT ?
        """, scriptId, limit));
  }

  protected void configurationChange(HttpExchange ex, Auth auth, int scriptId, int changeId) throws IOException, SQLException {
    requireScriptAccess(auth, scriptId);
    Map<String, Object> row = db.one("""
        SELECT id, script_id, file_path, file_name, file_type, changed_by, changed_at, change_summary, previous_content, updated_content
        FROM script_configuration_changes
        WHERE script_id = ? AND id = ?
        """, scriptId, changeId);
    if (row == null) throw new ApiException(404, "Change not found.");
    send(ex, 200, row);
  }

  protected Map<String, Object> changeSummary(String before, String after) {
    String[] beforeLines = splitLines(before);
    String[] afterLines = splitLines(after);
    int max = Math.max(beforeLines.length, afterLines.length);
    int modified = 0, added = 0, removed = 0;
    List<Map<String, Object>> preview = new ArrayList<>();
    for (int i = 0; i < max; i++) {
      String oldLine = i < beforeLines.length ? beforeLines[i] : null;
      String newLine = i < afterLines.length ? afterLines[i] : null;
      if (oldLine != null && newLine != null && oldLine.equals(newLine)) continue;
      String kind;
      if (oldLine == null) { kind = "added"; added++; }
      else if (newLine == null) { kind = "removed"; removed++; }
      else { kind = "modified"; modified++; }
      if (preview.size() < 20) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("line", i + 1);
        entry.put("beforeLine", oldLine == null ? null : i + 1);
        entry.put("afterLine", newLine == null ? null : i + 1);
        entry.put("before", oldLine == null ? "" : oldLine);
        entry.put("after", newLine == null ? "" : newLine);
        entry.put("kind", kind);
        preview.add(entry);
      }
    }
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("changedLines", modified + added + removed);
    out.put("modifiedLines", modified);
    out.put("addedLines", added);
    out.put("removedLines", removed);
    out.put("beforeLineCount", beforeLines.length);
    out.put("afterLineCount", afterLines.length);
    out.put("algorithmVersion", 1);
    out.put("isApproximate", false);
    out.put("preview", preview);
    if (!preview.isEmpty()) out.put("primaryChange", preview.get(0));
    return out;
  }

  private String[] splitLines(String value) {
    if (value == null || value.isEmpty()) return new String[0];
    return value.split("\\R", -1);
  }

  protected void attachment(HttpExchange ex, Map<String, String> q) throws IOException {
    Path path = Path.of(q.getOrDefault("path", ""));
    if (!Files.exists(path)) throw new ApiException(404, "File not found.");
    Headers h = ex.getResponseHeaders();
    if (Files.isDirectory(path)) {
      String zipName = path.getFileName() == null ? "attachment.zip" : path.getFileName() + ".zip";
      h.add("Content-Disposition", "attachment; filename=\"" + zipName + "\"");
      sendBytes(ex, 200, zipDirectory(path));
      return;
    }
    h.add("Content-Disposition", ("download".equals(q.get("mode")) ? "attachment" : "inline") + "; filename=\"" + path.getFileName() + "\"");
    sendBytes(ex, 200, Files.readAllBytes(path));
  }

  protected byte[] zipDirectory(Path directory) throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    try (ZipOutputStream zip = new ZipOutputStream(bytes); var paths = Files.walk(directory)) {
      paths.filter(Files::isRegularFile).forEach(path -> {
        try {
          String entryName = directory.relativize(path).toString().replace('\\', '/');
          zip.putNextEntry(new ZipEntry(entryName));
          Files.copy(path, zip);
          zip.closeEntry();
        } catch (IOException e) {
          throw new RuntimeException(e);
        }
      });
    } catch (RuntimeException e) {
      if (e.getCause() instanceof IOException io) throw io;
      throw e;
    }
    return bytes.toByteArray();
  }

  protected void assignments(HttpExchange ex, Auth auth) throws IOException, SQLException {
    admin(auth);
    List<Map<String, Object>> users = db.rows("""
        SELECT u.id AS user_id, u.username, u.full_name, u.role
        FROM users u
        WHERE u.role = 'tester'
        ORDER BY u.username
        """);
    for (Map<String, Object> user : users) {
      user.put("assignments", db.rows("""
          SELECT sa.script_id, s.name AS script_name, sa.assigned_at, ab.full_name AS assigned_by_name
          FROM script_assignments sa JOIN scripts s ON s.id = sa.script_id
          LEFT JOIN users ab ON ab.id = sa.assigned_by
          WHERE sa.user_id = ? ORDER BY s.name
          """, user.get("userId")));
    }
    send(ex, 200, users);
  }

  protected void userAssignments(HttpExchange ex, Auth auth, int userId) throws IOException, SQLException {
    admin(auth);
    send(ex, 200, Map.of("userId", userId, "scriptIds", db.rows("SELECT script_id FROM script_assignments WHERE user_id = ? ORDER BY script_id", userId).stream().map(r -> r.get("scriptId")).toList()));
  }

  protected void updateAssignments(HttpExchange ex, Auth auth, int userId) throws IOException, SQLException {
    admin(auth);
    List<Integer> ids = intList(body(ex).get("scriptIds"));
    db.update("DELETE FROM script_assignments WHERE user_id = ?", userId);
    for (Integer sid : ids) db.update("INSERT INTO script_assignments (user_id, script_id, assigned_by) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", userId, sid, auth.userId);
    send(ex, 200, Map.of("success", true, "userId", userId, "assignedCount", ids.size()));
  }

}
