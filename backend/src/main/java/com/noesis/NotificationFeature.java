package com.noesis;

import com.sun.net.httpserver.HttpExchange;
import java.io.IOException;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;

class NotificationFeature extends ExecutionFeature {
  protected void notifications(HttpExchange ex, Auth auth, Map<String, String> q) throws IOException, SQLException {
    int days = Integer.parseInt(q.getOrDefault("days", "30"));
    send(ex, 200, db.rows("SELECT * FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND created_at >= NOW() - (? || ' days')::interval ORDER BY created_at DESC LIMIT 200", auth.userId, days));
  }

  protected void createNotification(HttpExchange ex, Auth auth) throws IOException, SQLException {
    Map<String, Object> b = body(ex);
    Object targetUser = b.get("user_id") == null ? auth.userId : b.get("user_id");
    send(ex, 200, db.one("INSERT INTO notifications (user_id, severity, summary, detail, icon, source, category, action_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at",
        targetUser, b.get("severity"), b.get("summary"), b.get("detail"), b.get("icon"), b.getOrDefault("source", "System"), b.getOrDefault("category", "General"), b.get("action_url")));
  }

  protected void readNotification(HttpExchange ex, int id) throws IOException, SQLException { db.update("UPDATE notifications SET is_read = TRUE WHERE id = ?", id); send(ex, 200, Map.of("success", true)); }
  protected void deleteNotification(HttpExchange ex, int id) throws IOException, SQLException { db.update("DELETE FROM notifications WHERE id = ?", id); send(ex, 200, Map.of("success", true)); }
  protected void readNotifications(HttpExchange ex, Auth auth) throws IOException, SQLException { db.update("UPDATE notifications SET is_read = TRUE WHERE user_id = ? OR user_id IS NULL", auth.userId); send(ex, 200, Map.of("success", true)); }
  protected void clearNotifications(HttpExchange ex, Auth auth) throws IOException, SQLException { int n = db.update("DELETE FROM notifications WHERE user_id = ? OR user_id IS NULL", auth.userId); send(ex, 200, Map.of("success", true, "deleted", n)); }
  protected void markNotifications(HttpExchange ex) throws IOException, SQLException { updateNotificationIds(ex, "UPDATE notifications SET is_read = TRUE WHERE id IN (", "updated"); }
  protected void deleteNotifications(HttpExchange ex) throws IOException, SQLException { updateNotificationIds(ex, "DELETE FROM notifications WHERE id IN (", "deleted"); }

  protected void updateNotificationIds(HttpExchange ex, String prefix, String countKey) throws IOException, SQLException {
    List<Integer> ids = intList(body(ex).get("ids"));
    if (ids.isEmpty()) throw new ApiException(400, "Invalid IDs");
    db.update(prefix + placeholders(ids.size()) + ")", ids.toArray());
    send(ex, 200, Map.of("success", true, countKey, ids.size()));
  }

}