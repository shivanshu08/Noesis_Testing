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
    Map<String, Object> created = db.one("INSERT INTO test_suites (name, description, is_parallel, thread_count, tags, created_by) VALUES (?, ?, ?, ?, ?::jsonb, ?) RETURNING id",
        name, b.get("description"), b.getOrDefault("isParallel", false), b.getOrDefault("threadCount", 1), b.containsKey("tags") ? json(b.get("tags")) : null, auth.userId);
    int suiteId = intValue(created.get("id"), 0);
    int order = 1;
    for (Integer sid : scriptIds) db.update("INSERT INTO suite_scripts (suite_id, script_id, execution_order) VALUES (?, ?, ?)", suiteId, sid, order++);
    send(ex, 201, Map.of("id", suiteId, "message", "Suite created."));
  }

  protected void updateSuite(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    edit(auth);
    Map<String, Object> b = body(ex);
    db.update("UPDATE test_suites SET name = COALESCE(?, name), description = COALESCE(?, description), is_parallel = COALESCE(?, is_parallel), thread_count = COALESCE(?, thread_count), tags = COALESCE(?::jsonb, tags), updated_at = NOW() WHERE id = ?",
        b.get("name"), b.get("description"), b.get("isParallel"), b.get("threadCount"), b.containsKey("tags") ? json(b.get("tags")) : null, id);
    if (b.containsKey("scriptIds")) {
      db.update("DELETE FROM suite_scripts WHERE suite_id = ?", id);
      int order = 1;
      for (Integer sid : intList(b.get("scriptIds"))) db.update("INSERT INTO suite_scripts (suite_id, script_id, execution_order) VALUES (?, ?, ?)", id, sid, order++);
    }
    send(ex, 200, message("Suite updated."));
  }

  protected void duplicateSuite(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    edit(auth);
    Map<String, Object> source = db.one("SELECT * FROM test_suites WHERE id = ?", id);
    if (source == null) throw new ApiException(404, "Source suite not found.");
    String newName = "Copy of " + str(source.get("name"));
    Map<String, Object> created = db.one("INSERT INTO test_suites (name, description, is_parallel, thread_count, tags, created_by) VALUES (?, ?, ?, ?, ?::jsonb, ?) RETURNING id",
        newName, source.get("description"), source.get("isParallel"), source.get("threadCount"), json(source.get("tags")), auth.userId);
    int newId = intValue(created.get("id"), 0);
    for (Map<String, Object> s : db.rows("SELECT script_id, execution_order FROM suite_scripts WHERE suite_id = ?", id)) {
      db.update("INSERT INTO suite_scripts (suite_id, script_id, execution_order) VALUES (?, ?, ?)", newId, s.get("scriptId"), s.get("executionOrder"));
    }
    send(ex, 201, Map.of("id", newId, "name", newName, "message", "Suite duplicated successfully."));
  }

  protected void deleteSuite(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    admin(auth);
    db.update("DELETE FROM test_suites WHERE id = ?", id);
    send(ex, 200, message("Suite deleted."));
  }

}
