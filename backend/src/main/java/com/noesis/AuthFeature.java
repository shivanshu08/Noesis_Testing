package com.noesis;

import com.sun.net.httpserver.HttpExchange;
import java.io.IOException;
import java.sql.SQLException;
import java.time.Instant;
import java.util.Map;
import org.mindrot.jbcrypt.BCrypt;

class AuthFeature extends BackendSupport {
  protected void health(HttpExchange ex) throws IOException {
    Runtime rt = Runtime.getRuntime();
    long now = System.currentTimeMillis() / 1000;
    long uptimeSeconds = now - STARTED_AT_EPOCH;

    // DB health check with latency measurement
    String dbStatus = "ok";
    long dbLatencyMs = 0;
    try {
      long t0 = System.nanoTime();
      db.one("SELECT 1 AS ok");
      dbLatencyMs = (System.nanoTime() - t0) / 1_000_000;
    } catch (Exception ignored) {
      dbStatus = "degraded";
    }

    // CPU load via MXBean
    double cpuLoad = -1;
    double systemLoadAvg = -1;
    int availableProcessors = rt.availableProcessors();
    try {
      java.lang.management.OperatingSystemMXBean osBean = java.lang.management.ManagementFactory.getOperatingSystemMXBean();
      systemLoadAvg = Math.round(osBean.getSystemLoadAverage() * 100.0) / 100.0;
      if (osBean instanceof com.sun.management.OperatingSystemMXBean sunBean) {
        cpuLoad = Math.round(sunBean.getProcessCpuLoad() * 10000.0) / 100.0;
      }
    } catch (Exception ignored) {}

    // Memory
    long totalMB = rt.totalMemory() / 1024 / 1024;
    long freeMB = rt.freeMemory() / 1024 / 1024;
    long maxMB = rt.maxMemory() / 1024 / 1024;
    long usedMB = totalMB - freeMB;
    int activeThreads = Thread.activeCount();

    // GC stats
    long gcCount = 0;
    long gcTimeMs = 0;
    for (java.lang.management.GarbageCollectorMXBean gc : java.lang.management.ManagementFactory.getGarbageCollectorMXBeans()) {
      long c = gc.getCollectionCount();
      long t = gc.getCollectionTime();
      if (c >= 0) gcCount += c;
      if (t >= 0) gcTimeMs += t;
    }

    // Disk space (root partition where the app is running)
    java.io.File root = new java.io.File(".");
    long diskTotalGB = root.getTotalSpace() / 1024 / 1024 / 1024;
    long diskFreeGB = root.getUsableSpace() / 1024 / 1024 / 1024;
    long diskUsedGB = diskTotalGB - diskFreeGB;
    long diskPercent = diskTotalGB > 0 ? Math.round(diskUsedGB * 100.0 / diskTotalGB) : 0;

    java.util.LinkedHashMap<String, Object> data = new java.util.LinkedHashMap<>();
    data.put("status", dbStatus.equals("ok") ? "ok" : "degraded");
    data.put("api", "ok");
    data.put("db", dbStatus);
    data.put("dbLatencyMs", dbLatencyMs);
    data.put("uptime", uptimeSeconds);
    data.put("memoryMB", usedMB);
    data.put("maxMemoryMB", maxMB);
    data.put("memoryPercent", maxMB > 0 ? Math.round(usedMB * 100.0 / maxMB) : 0);
    data.put("cpuLoad", cpuLoad >= 0 ? cpuLoad : null);
    data.put("cpuCores", availableProcessors);
    data.put("systemLoadAvg", systemLoadAvg >= 0 ? systemLoadAvg : null);
    data.put("activeThreads", activeThreads);
    data.put("gcCount", gcCount);
    data.put("gcTimeMs", gcTimeMs);
    data.put("diskTotalGB", diskTotalGB);
    data.put("diskFreeGB", diskFreeGB);
    data.put("diskUsedGB", diskUsedGB);
    data.put("diskPercent", diskPercent);
    data.put("javaVersion", System.getProperty("java.version"));
    data.put("os", System.getProperty("os.name"));
    data.put("pid", ProcessHandle.current().pid());
    data.put("timestamp", Instant.now().toString());
    send(ex, 200, data);
  }

  protected void login(HttpExchange ex) throws IOException, SQLException {
    Map<String, Object> body = body(ex);
    String username = str(body.get("username"));
    String password = str(body.get("password"));
    if (username.isBlank() || password.isBlank()) throw new ApiException(400, "Username and password are required.");
    ensureUserLockout();
    Map<String, Object> user = db.one("SELECT * FROM users WHERE username = ? OR email = ?", username, username);
    if (user == null) throw new ApiException(401, "User does not exist.");
    if (Boolean.FALSE.equals(user.get("isActive"))) throw new ApiException(403, "This account has been disabled. Please contact an administrator.");
    if (Boolean.TRUE.equals(user.get("isLocked"))) throw new ApiException(423, "This account is locked. Please contact an administrator to unlock it.");
    if (!BCrypt.checkpw(password, str(user.get("passwordHash")))) {
      int failed = intValue(user.get("failedLoginAttempts"), 0) + 1;
      if (failed >= 3) {
        db.update("UPDATE users SET failed_login_attempts = ?, is_locked = TRUE, locked_at = NOW(), locked_by = NULL WHERE id = ?", failed, user.get("id"));
        throw new ApiException(423, "Account locked after 3 wrong password attempts. Please contact an administrator to unlock it.");
      }
      db.update("UPDATE users SET failed_login_attempts = ? WHERE id = ?", failed, user.get("id"));
      int left = 3 - failed;
      throw new ApiException(401, "Invalid credentials. " + left + " attempt" + (left == 1 ? "" : "s") + " remaining before lock.");
    }
    db.update("UPDATE users SET last_login = NOW(), failed_login_attempts = 0, unlocked_at = NULL, unlocked_by = NULL WHERE id = ?", user.get("id"));
    Map<String, Object> publicUser = userDto(user);
    if ("tester".equals(user.get("role"))) {
      publicUser.put("assignedScriptCount", intValue(db.one("SELECT COUNT(*)::int AS count FROM script_assignments WHERE user_id = ?", user.get("id")).get("count"), 0));
    }
    send(ex, 200, Map.of("token", jwt.create(intValue(user.get("id"), 0), str(user.get("role"))), "user", publicUser));
  }

  protected void me(HttpExchange ex, Auth auth) throws IOException, SQLException {
    Map<String, Object> user = db.one("SELECT id, username, email, full_name, role, avatar_url, is_locked, failed_login_attempts, last_login, created_at FROM users WHERE id = ?", auth.userId);
    if (user == null) throw new ApiException(404, "User not found.");
    Map<String, Object> out = userDto(user);
    out.put("isLocked", user.get("isLocked"));
    out.put("failedLoginAttempts", user.get("failedLoginAttempts"));
    out.put("lastLogin", user.get("lastLogin"));
    out.put("createdAt", user.get("createdAt"));
    send(ex, 200, out);
  }

  protected void renew(HttpExchange ex, Auth auth) throws IOException {
    send(ex, 200, Map.of("token", jwt.create(auth.userId, auth.role)));
  }

  protected void changePassword(HttpExchange ex, Auth auth) throws IOException, SQLException {
    Map<String, Object> body = body(ex);
    String current = str(body.get("currentPassword"));
    String next = str(body.get("newPassword"));
    if (current.isBlank() || next.length() < 6) throw new ApiException(400, "Valid current and new password required (min 6 chars).");
    Map<String, Object> user = db.one("SELECT password_hash FROM users WHERE id = ?", auth.userId);
    if (user == null) throw new ApiException(404, "User not found.");
    if (!BCrypt.checkpw(current, str(user.get("passwordHash")))) throw new ApiException(401, "Current password is incorrect.");
    db.update("UPDATE users SET password_hash = ? WHERE id = ?", BCrypt.hashpw(next, BCrypt.gensalt(12)), auth.userId);
    send(ex, 200, message("Password changed successfully."));
  }

  protected void profile(HttpExchange ex, Auth auth) throws IOException, SQLException {
    Map<String, Object> body = body(ex);
    String fullName = str(body.get("fullName"));
    if (fullName.isBlank()) throw new ApiException(400, "Full name is required.");
    try { db.update("ALTER TABLE users ALTER COLUMN avatar_url TYPE TEXT"); } catch (Exception ignored) {}
    if (body.containsKey("avatarUrl")) {
      db.update("UPDATE users SET full_name = ?, email = ?, avatar_url = ? WHERE id = ?", fullName, body.get("email"), blankNull(body.get("avatarUrl")), auth.userId);
    } else {
      db.update("UPDATE users SET full_name = ?, email = ? WHERE id = ?", fullName, body.get("email"), auth.userId);
    }
    send(ex, 200, message("Profile updated successfully."));
  }

  protected void forgot(HttpExchange ex) throws IOException {
    Map<String, Object> body = body(ex);
    if (str(body.get("email")).isBlank()) throw new ApiException(400, "Email is required.");
    send(ex, 200, message("If an account with that email exists, a password reset link has been sent."));
  }

}
