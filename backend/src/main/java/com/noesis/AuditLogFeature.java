package com.noesis;


import com.sun.net.httpserver.HttpExchange;
import java.io.IOException;
import java.sql.SQLException;
import java.util.Map;

class AuditLogFeature extends NotificationFeature {
  protected void logs(HttpExchange ex, Auth auth) throws IOException, SQLException { edit(auth); send(ex, 200, db.rows("SELECT * FROM app_logs ORDER BY timestamp DESC LIMIT 300")); }
  protected void createLog(HttpExchange ex, Auth auth) throws IOException, SQLException {
    Map<String, Object> b = body(ex);
    db.update("INSERT INTO app_logs (severity, module, action, status, message, user_id, username, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb)",
        b.getOrDefault("severity", b.getOrDefault("level", "INFO")), b.getOrDefault("module", "frontend"), b.get("action"), b.get("status"), b.getOrDefault("message", b.getOrDefault("detail", "")), auth.userId, auth.username, b.containsKey("metadata") ? json(b.get("metadata")) : null);
    send(ex, 200, Map.of("success", true));
  }
  protected void logModules(HttpExchange ex, Map<String, String> q) throws IOException, SQLException {
    send(ex, 200, db.rows("""
        WITH modules_union AS (
          SELECT LOWER(COALESCE(NULLIF(module,''),'application')) AS module, timestamp FROM app_logs
          UNION ALL
          SELECT LOWER(COALESCE(NULLIF(source_component,''),'execution-engine')) AS module, timestamp FROM execution_logs
        )
        SELECT module AS value, module AS label, COUNT(*)::int AS count
        FROM modules_union
        WHERE (? IS NULL OR timestamp >= ?::timestamp)
          AND (? IS NULL OR timestamp <= ?::timestamp)
          AND (? IS NULL OR module ILIKE ?)
        GROUP BY module ORDER BY count DESC, module LIMIT 200
        """, blankNull(q.get("from")), blankNull(q.get("from")), blankNull(q.get("to")), blankNull(q.get("to")), blankNull(q.get("q")), q.containsKey("q") ? "%" + q.get("q") + "%" : null));
  }
  protected void logActions(HttpExchange ex, Map<String, String> q) throws IOException, SQLException {
    send(ex, 200, db.rows("""
        SELECT action AS value, action AS label, COUNT(*)::int AS count
        FROM app_logs
        WHERE action IS NOT NULL AND action <> ''
          AND (? IS NULL OR timestamp >= ?::timestamp)
          AND (? IS NULL OR timestamp <= ?::timestamp)
          AND (? IS NULL OR action ILIKE ?)
          AND (? IS NULL OR module ILIKE ?)
        GROUP BY action ORDER BY count DESC, action LIMIT 300
        """, blankNull(q.get("from")), blankNull(q.get("from")), blankNull(q.get("to")), blankNull(q.get("to")), blankNull(q.get("q")), q.containsKey("q") ? "%" + q.get("q") + "%" : null, blankNull(q.get("module")), q.containsKey("module") ? "%" + q.get("module") + "%" : null));
  }

}
