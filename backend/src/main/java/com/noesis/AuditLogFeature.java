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
  protected void logModules(HttpExchange ex) throws IOException, SQLException { send(ex, 200, db.rows("SELECT LOWER(COALESCE(NULLIF(module,''),'application')) AS value, LOWER(COALESCE(NULLIF(module,''),'application')) AS label, COUNT(*)::int AS count FROM app_logs GROUP BY value ORDER BY count DESC, value LIMIT 200")); }
  protected void logActions(HttpExchange ex) throws IOException, SQLException { send(ex, 200, db.rows("SELECT action AS value, action AS label, COUNT(*)::int AS count FROM app_logs WHERE action IS NOT NULL AND action <> '' GROUP BY action ORDER BY count DESC, action LIMIT 300")); }

}
