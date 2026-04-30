package com.noesis;


import com.sun.net.httpserver.HttpExchange;
import java.io.IOException;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

class SuiteManagementFeature extends ScriptManagementFeature {
  protected void suites(HttpExchange ex, Auth auth) throws IOException, SQLException {
    List<Object> params = new ArrayList<>();
    String filter = "";
    if ("tester".equals(auth.role)) {
      filter = " AND NOT EXISTS (SELECT 1 FROM suite_scripts ss WHERE ss.suite_id = ts.id AND ss.script_id NOT IN (SELECT sa.script_id FROM script_assignments sa WHERE sa.user_id = ?)) AND EXISTS (SELECT 1 FROM suite_scripts ss WHERE ss.suite_id = ts.id)";
      params.add(auth.userId);
    }
    send(ex, 200, db.rows("""
        SELECT ts.*, u.full_name AS created_by_name,
          (SELECT COUNT(*)::int FROM suite_scripts ss WHERE ss.suite_id = ts.id) AS script_count
        FROM test_suites ts LEFT JOIN users u ON ts.created_by = u.id
        WHERE 1=1
        """ + filter + " ORDER BY ts.name", params.toArray()));
  }

  protected void suite(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    Map<String, Object> suite = db.one("SELECT ts.*, u.full_name AS created_by_name FROM test_suites ts LEFT JOIN users u ON ts.created_by = u.id WHERE ts.id = ?", id);
    if (suite == null) throw new ApiException(404, "Suite not found.");
    requireSuiteAccess(auth, id, "Access denied: This suite contains scripts not assigned to you.");
    suite.put("scripts", db.rows("""
        SELECT s.id, s.name, s.class_name, sc.name AS category_name, sc.color AS category_color, ss.execution_order
        FROM suite_scripts ss JOIN scripts s ON ss.script_id = s.id JOIN script_categories sc ON s.category_id = sc.id
        WHERE ss.suite_id = ? ORDER BY ss.execution_order
        """, id));
    send(ex, 200, suite);
  }

  protected void createSuite(HttpExchange ex, Auth auth) throws IOException, SQLException {
    edit(auth);
    Map<String, Object> b = body(ex);
    String name = str(b.get("name")).trim();
    List<Integer> scriptIds = intList(b.get("scriptIds"));
    if (name.isBlank() || scriptIds.isEmpty()) throw new ApiException(400, "Suite name and at least one script are required.");
    if ("tester".equals(auth.role) && !hasAssignedScripts(auth.userId, scriptIds)) throw new ApiException(403, "Access denied: One or more scripts are not assigned to you.");
    Map<String, Object> created = db.one("INSERT INTO test_suites (name, description, is_parallel, thread_count, tags, created_by) VALUES (?, ?, ?, ?, ?::jsonb, ?) RETURNING id",
        name, b.get("description"), b.getOrDefault("isParallel", false), b.getOrDefault("threadCount", 1), b.containsKey("tags") ? json(b.get("tags")) : null, auth.userId);
    int suiteId = intValue(created.get("id"), 0);
    int order = 1;
    for (Integer sid : scriptIds) db.update("INSERT INTO suite_scripts (suite_id, script_id, execution_order) VALUES (?, ?, ?)", suiteId, sid, order++);
    logSuiteEvent(auth, "SUITES_CREATE", "Suite created: \"" + name + "\".", Map.of("suiteId", suiteId, "suiteName", name, "scriptIds", scriptIds, "scriptCount", scriptIds.size()));
    send(ex, 201, Map.of("id", suiteId, "message", "Suite created."));
  }

  protected void updateSuite(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    edit(auth);
    Map<String, Object> b = body(ex);
    if (db.one("SELECT id FROM test_suites WHERE id = ?", id) == null) throw new ApiException(404, "Suite not found.");
    requireSuiteAccess(auth, id, "Access denied: You do not have permission to modify this suite as it contains scripts not assigned to you.");
    if (b.containsKey("scriptIds")) {
      List<Integer> newIds = intList(b.get("scriptIds"));
      if (newIds.isEmpty()) throw new ApiException(400, "At least one valid script is required.");
      if ("tester".equals(auth.role) && !hasAssignedScripts(auth.userId, newIds)) throw new ApiException(403, "Access denied: One or more scripts are not assigned to you.");
    }
    db.update("UPDATE test_suites SET name = COALESCE(?, name), description = COALESCE(?, description), is_parallel = COALESCE(?, is_parallel), thread_count = COALESCE(?, thread_count), tags = COALESCE(?::jsonb, tags), updated_at = NOW() WHERE id = ?",
        b.get("name"), b.get("description"), b.get("isParallel"), b.get("threadCount"), b.containsKey("tags") ? json(b.get("tags")) : null, id);
    if (b.containsKey("scriptIds")) {
      db.update("DELETE FROM suite_scripts WHERE suite_id = ?", id);
      int order = 1;
      for (Integer sid : intList(b.get("scriptIds"))) db.update("INSERT INTO suite_scripts (suite_id, script_id, execution_order) VALUES (?, ?, ?)", id, sid, order++);
    }
    logSuiteEvent(auth, "SUITES_UPDATE", "Suite updated: #" + id + ".", Map.of("suiteId", id));
    send(ex, 200, message("Suite updated."));
  }

  protected void duplicateSuite(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    edit(auth);
    Map<String, Object> source = db.one("SELECT * FROM test_suites WHERE id = ?", id);
    if (source == null) throw new ApiException(404, "Source suite not found.");
    requireSuiteAccess(auth, id, "Access denied: You cannot duplicate this suite as it contains scripts not assigned to you.");
    String newName = "Copy of " + str(source.get("name"));
    Map<String, Object> created = db.one("INSERT INTO test_suites (name, description, is_parallel, thread_count, tags, created_by) VALUES (?, ?, ?, ?, ?::jsonb, ?) RETURNING id",
        newName, source.get("description"), source.get("isParallel"), source.get("threadCount"), json(source.get("tags")), auth.userId);
    int newId = intValue(created.get("id"), 0);
    for (Map<String, Object> s : db.rows("SELECT script_id, execution_order FROM suite_scripts WHERE suite_id = ?", id)) {
      db.update("INSERT INTO suite_scripts (suite_id, script_id, execution_order) VALUES (?, ?, ?)", newId, s.get("scriptId"), s.get("executionOrder"));
    }
    logSuiteEvent(auth, "SUITES_CREATE", "Suite duplicated: \"" + str(source.get("name")) + "\" -> \"" + newName + "\".", Map.of("sourceSuiteId", id, "sourceSuiteName", source.get("name"), "newSuiteId", newId, "newSuiteName", newName, "operation", "duplicate"));
    send(ex, 201, Map.of("id", newId, "name", newName, "message", "Suite duplicated successfully."));
  }

  protected void deleteSuite(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    admin(auth);
    Map<String, Object> before = db.one("SELECT name FROM test_suites WHERE id = ?", id);
    if (before == null) throw new ApiException(404, "Suite not found.");
    db.update("DELETE FROM test_suites WHERE id = ?", id);
    logSuiteEvent(auth, "SUITES_DELETE", "Suite deleted: \"" + str(before.get("name")) + "\".", Map.of("suiteId", id, "suiteName", before.get("name")));
    send(ex, 200, message("Suite deleted."));
  }

  protected void suiteAudit(HttpExchange ex, Map<String, String> q) throws IOException, SQLException {
    List<Object> params = new ArrayList<>();
    StringBuilder where = new StringBuilder("WHERE al.module = 'suites'");
    if (q.containsKey("suiteId") && !q.get("suiteId").isBlank()) {
      where.append(" AND (COALESCE(al.metadata->>'suiteId','') = ? OR COALESCE(al.metadata->>'newSuiteId','') = ? OR COALESCE(al.metadata->>'sourceSuiteId','') = ?)");
      params.add(q.get("suiteId")); params.add(q.get("suiteId")); params.add(q.get("suiteId"));
    }
    if (q.containsKey("action") && !q.get("action").isBlank()) {
      List<String> actions = List.of(q.get("action").split(",")).stream().map(String::trim).filter(s -> !s.isBlank()).toList();
      if (!actions.isEmpty()) {
        where.append(" AND al.action IN (").append(placeholders(actions.size())).append(")");
        params.addAll(actions);
      }
    }
    if (q.containsKey("days") && !q.get("days").isBlank()) {
      where.append(" AND al.timestamp >= NOW() - (? || ' days')::interval");
      params.add(Math.max(1, Math.min(365, intValue(q.get("days"), 30))));
    }
    int limit = Math.max(1, Math.min(1000, intValue(q.get("limit"), 200)));
    params.add(limit);
    List<Map<String, Object>> rows = db.rows("""
        SELECT al.id, al.timestamp, al.action, al.severity, al.status, al.message, al.username,
          al.user_id, al.request_id, al.http_method, al.http_path, al.http_status, al.metadata,
          u.full_name AS user_full_name, u.username AS user_username
        FROM app_logs al
        LEFT JOIN users u ON u.id = al.user_id
        """ + where + " ORDER BY al.timestamp DESC LIMIT ?", params.toArray());
    for (Map<String, Object> row : rows) {
      Object rawMetadata = row.get("metadata");
      Map<?, ?> metadata = rawMetadata instanceof Map<?, ?> m ? m : Map.of();
      row.put("actor", firstNonBlank(str(metadata.get("actorName")), str(row.get("userFullName")), str(row.get("username")), str(row.get("userUsername")), "Unknown user"));
      row.put("suiteId", firstNonBlank(str(metadata.get("suiteId")), str(metadata.get("newSuiteId")), str(metadata.get("sourceSuiteId"))));
      row.put("suiteName", firstNonBlank(str(metadata.get("suiteName")), str(metadata.get("newSuiteName")), str(metadata.get("sourceSuiteName"))));
      row.put("operation", str(metadata.get("operation")).isBlank() ? null : metadata.get("operation"));
      row.put("changedParts", metadata.get("changedParts") == null ? List.of() : metadata.get("changedParts"));
    }
    send(ex, 200, rows);
  }

  protected void requireSuiteAccess(Auth auth, int suiteId, String message) throws SQLException {
    if (!"tester".equals(auth.role)) return;
    int unavailable = intValue(db.one("""
        SELECT COUNT(*)::int AS count
        FROM suite_scripts ss
        WHERE ss.suite_id = ?
          AND ss.script_id NOT IN (SELECT script_id FROM script_assignments WHERE user_id = ?)
        """, suiteId, auth.userId).get("count"), 0);
    int total = intValue(db.one("SELECT COUNT(*)::int AS count FROM suite_scripts WHERE suite_id = ?", suiteId).get("count"), 0);
    if (unavailable > 0 || total == 0) throw new ApiException(403, message);
  }

  protected void logSuiteEvent(Auth auth, String action, String message, Map<String, Object> metadata) {
    try {
      db.update("INSERT INTO app_logs (severity, module, action, status, message, user_id, username, metadata) VALUES ('INFO', 'suites', ?, 'SUCCESS', ?, ?, ?, ?::jsonb)",
          action, message, auth.userId, auth.username, json(metadata));
    } catch (Exception ignored) {}
  }

}
