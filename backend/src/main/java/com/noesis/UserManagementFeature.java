package com.noesis;

import com.sun.net.httpserver.HttpExchange;
import java.io.IOException;
import java.sql.SQLException;
import java.util.Map;
import org.mindrot.jbcrypt.BCrypt;

class UserManagementFeature extends AuthFeature {
  protected void users(HttpExchange ex, Auth auth) throws IOException, SQLException {
    admin(auth);
    ensureAssignments();
    ensureUserLockout();
    send(ex, 200, db.rows("""
        SELECT u.id, u.username, u.email, u.full_name, u.role, u.is_active, u.avatar_url, u.last_login,
          u.run_count, u.suites_created, u.scripts_registered, u.created_at,
          u.failed_login_attempts, u.is_locked, u.locked_at, u.unlocked_at,
          COALESCE(sa_counts.assigned_script_count, 0)::int AS assigned_script_count
        FROM users u
        LEFT JOIN (SELECT user_id, COUNT(*)::int AS assigned_script_count FROM script_assignments GROUP BY user_id) sa_counts
          ON sa_counts.user_id = u.id
        ORDER BY u.created_at DESC
        """));
  }

  protected void createUser(HttpExchange ex, Auth auth) throws IOException, SQLException {
    admin(auth);
    Map<String, Object> body = body(ex);
    String username = str(body.get("username"));
    String password = str(body.get("password"));
    String fullName = str(body.get("fullName"));
    if (username.isBlank() || password.isBlank() || fullName.isBlank()) throw new ApiException(400, "Username, password, and full name are required.");
    Map<String, Object> created = db.one(
        "INSERT INTO users (username, email, password_hash, full_name, role, is_active, avatar_url) VALUES (?, ?, ?, ?, ?::user_role, ?, ?) RETURNING id",
        username, body.get("email"), BCrypt.hashpw(password, BCrypt.gensalt(12)), fullName, body.getOrDefault("role", "tester"), body.getOrDefault("isActive", true), body.get("avatarUrl"));
    send(ex, 201, Map.of("message", "User created successfully.", "userId", created.get("id")));
  }

  protected void updateUser(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    admin(auth);
    Map<String, Object> body = body(ex);
    db.update("UPDATE users SET full_name = ?, email = ?, role = ?::user_role, is_active = ?, avatar_url = ? WHERE id = ?",
        body.get("fullName"), body.get("email"), body.get("role"), body.get("isActive"), body.get("avatarUrl"), id);
    send(ex, 200, message("User updated successfully."));
  }

  protected void lockUser(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    admin(auth);
    boolean locked = Boolean.TRUE.equals(body(ex).get("isLocked"));
    if (locked && id == auth.userId) throw new ApiException(400, "You cannot lock your own account.");
    int rows = locked
        ? db.update("UPDATE users SET is_locked = TRUE, failed_login_attempts = 3, locked_at = NOW(), locked_by = ? WHERE id = ?", auth.userId, id)
        : db.update("UPDATE users SET is_locked = FALSE, failed_login_attempts = 0, unlocked_at = NOW(), unlocked_by = ? WHERE id = ?", auth.userId, id);
    if (rows == 0) throw new ApiException(404, "User not found.");
    send(ex, 200, message("User " + (locked ? "locked" : "unlocked") + " successfully."));
  }

  protected void deleteUser(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    admin(auth);
    if (id == auth.userId) throw new ApiException(400, "You cannot delete your own account.");
    db.update("DELETE FROM users WHERE id = ?", id);
    send(ex, 204, null);
  }

}
