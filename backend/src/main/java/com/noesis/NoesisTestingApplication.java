package com.noesis;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import jakarta.activation.DataHandler;
import jakarta.activation.FileDataSource;
import jakarta.mail.Authenticator;
import jakarta.mail.Message;
import jakarta.mail.MessagingException;
import jakarta.mail.Multipart;
import jakarta.mail.PasswordAuthentication;
import jakarta.mail.Session;
import jakarta.mail.Transport;
import jakarta.mail.internet.InternetAddress;
import jakarta.mail.internet.MimeBodyPart;
import jakarta.mail.internet.MimeMessage;
import jakarta.mail.internet.MimeMultipart;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.mindrot.jbcrypt.BCrypt;
import org.postgresql.util.PGobject;

public class NoesisTestingApplication {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {};
  private static final TypeReference<Object> ANY = new TypeReference<>() {};

  private final Env env;
  private final Db db;
  private final Jwt jwt;
  private final Map<Integer, Process> activeProcesses = new ConcurrentHashMap<>();

  public static void main(String[] args) throws Exception {
    Env.loadDotenv();
    NoesisTestingApplication app = new NoesisTestingApplication();
    app.start();
  }

  NoesisTestingApplication() {
    this.env = new Env();
    this.db = new Db(env);
    this.jwt = new Jwt(env.jwtSecret(), env.jwtExpiresIn());
  }

  void start() throws IOException {
    ensureSchema();
    int port = env.intValue("PORT", 3000);
    HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
    server.createContext("/", this::handle);
    server.setExecutor(Executors.newCachedThreadPool());
    Runtime.getRuntime().addShutdownHook(new Thread(() -> activeProcesses.values().forEach(Process::destroy)));
    server.start();
    System.out.println("Noesis plain Java API running on port " + port);
  }

  private void handle(HttpExchange ex) throws IOException {
    try {
      addCors(ex);
      if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
        send(ex, 204, null);
        return;
      }

      String method = ex.getRequestMethod().toUpperCase(Locale.ROOT);
      String path = ex.getRequestURI().getPath();
      Map<String, String> query = query(ex.getRequestURI());

      if (method.equals("GET") && path.equals("/api/health")) {
        health(ex);
        return;
      }
      if (method.equals("POST") && path.equals("/api/auth/login")) {
        login(ex);
        return;
      }
      if (method.equals("POST") && path.equals("/api/auth/forgot-password")) {
        forgot(ex);
        return;
      }

      Auth auth = auth(ex);
      if (auth == null) return;

      if (path.equals("/api/auth/me") && method.equals("GET")) me(ex, auth);
      else if (path.equals("/api/auth/change-password") && method.equals("PUT")) changePassword(ex, auth);
      else if (path.equals("/api/auth/profile") && method.equals("PUT")) profile(ex, auth);
      else if (path.equals("/api/users") && method.equals("GET")) users(ex, auth);
      else if (path.equals("/api/users") && method.equals("POST")) createUser(ex, auth);
      else if (match(path, "/api/users/(\\d+)") && method.equals("PUT")) updateUser(ex, auth, id(path));
      else if (match(path, "/api/users/(\\d+)/lock") && method.equals("PUT")) lockUser(ex, auth, id(path));
      else if (match(path, "/api/users/(\\d+)") && method.equals("DELETE")) deleteUser(ex, auth, id(path));
      else if (path.equals("/api/scripts") && method.equals("GET")) scripts(ex, auth, query);
      else if (path.equals("/api/scripts/categories") && method.equals("GET")) categories(ex);
      else if (path.equals("/api/scripts/delete-multiple") && method.equals("POST")) deleteScripts(ex, auth);
      else if (path.equals("/api/scripts/sync") && method.equals("POST")) syncScripts(ex, auth);
      else if (path.equals("/api/scripts/import") && method.equals("POST")) importScript(ex, auth);
      else if (path.equals("/api/scripts/assignments") && method.equals("GET")) assignments(ex, auth);
      else if (match(path, "/api/scripts/assignments/(\\d+)") && method.equals("GET")) userAssignments(ex, auth, lastId(path));
      else if (match(path, "/api/scripts/assignments/(\\d+)") && method.equals("PUT")) updateAssignments(ex, auth, lastId(path));
      else if (match(path, "/api/scripts/(\\d+)/dependencies") && method.equals("PUT")) updateScriptDependencies(ex, auth, id(path));
      else if (match(path, "/api/scripts/(\\d+)/configuration") && method.equals("GET")) scriptConfiguration(ex, auth, id(path));
      else if (match(path, "/api/scripts/(\\d+)/configuration/file-content") && method.equals("GET")) fileContent(ex, query);
      else if (match(path, "/api/scripts/(\\d+)/configuration/file") && method.equals("PUT")) updateFile(ex, auth, id(path));
      else if (match(path, "/api/scripts/(\\d+)/configuration/changes") && method.equals("GET")) configurationChanges(ex, auth, id(path), query);
      else if (match(path, "/api/scripts/(\\d+)/configuration/changes/(\\d+)") && method.equals("GET")) configurationChange(ex, auth, id(path), lastId(path));
      else if (match(path, "/api/scripts/(\\d+)/configuration/attachment") && method.equals("GET")) attachment(ex, query);
      else if (match(path, "/api/scripts/(\\d+)") && method.equals("GET")) script(ex, id(path));
      else if (match(path, "/api/scripts/(\\d+)") && method.equals("PUT")) updateScript(ex, auth, id(path));
      else if (match(path, "/api/scripts/(\\d+)") && method.equals("DELETE")) deleteScript(ex, auth, id(path));
      else if (path.equals("/api/suites") && method.equals("GET")) suites(ex, auth);
      else if (path.equals("/api/suites") && method.equals("POST")) createSuite(ex, auth);
      else if (path.equals("/api/suites/audit") && method.equals("GET")) send(ex, 200, List.of());
      else if (match(path, "/api/suites/(\\d+)") && method.equals("GET")) suite(ex, auth, id(path));
      else if (match(path, "/api/suites/(\\d+)") && method.equals("PUT")) updateSuite(ex, auth, id(path));
      else if (match(path, "/api/suites/(\\d+)/duplicate") && method.equals("POST")) duplicateSuite(ex, auth, id(path));
      else if (match(path, "/api/suites/(\\d+)") && method.equals("DELETE")) deleteSuite(ex, auth, id(path));
      else if (path.equals("/api/execution/run") && method.equals("POST")) run(ex, auth);
      else if (match(path, "/api/execution/stop/(\\d+)") && method.equals("POST")) stopRun(ex, auth, lastId(path));
      else if (path.equals("/api/execution/runs") && method.equals("GET")) runs(ex, auth, query);
      else if (match(path, "/api/execution/runs/(\\d+)") && method.equals("GET")) runDetails(ex, auth, lastId(path));
      else if (path.equals("/api/execution/stats") && method.equals("GET")) stats(ex, auth);
      else if (match(path, "/api/execution/logs/(\\d+)") && method.equals("GET")) executionLogs(ex, lastId(path));
      else if (match(path, "/api/execution/runs/(\\d+)/artifacts") && method.equals("GET")) artifacts(ex, lastId(path));
      else if (match(path, "/api/execution/artifacts/(\\d+)/download") && method.equals("GET")) artifactDownload(ex, lastId(path));
      else if (match(path, "/api/execution/runs/(\\d+)/artifacts/mail") && method.equals("POST")) mailArtifacts(ex);
      else if (path.equals("/api/execution/global-logs") && method.equals("GET")) globalLogs(ex, query);
      else if (match(path, "/api/execution/global-logs/(\\d+)") && method.equals("DELETE")) deleteGlobalLog(ex, lastId(path));
      else if (path.equals("/api/execution/global-logs/delete-multiple") && method.equals("POST")) deleteGlobalLogs(ex);
      else if (path.equals("/api/execution/schedule") && method.equals("POST")) createSchedule(ex, auth);
      else if (path.equals("/api/execution/schedules") && method.equals("GET")) schedules(ex);
      else if (match(path, "/api/execution/schedules/(\\d+)") && method.equals("PUT")) updateSchedule(ex, lastId(path));
      else if (match(path, "/api/execution/schedules/(\\d+)") && method.equals("DELETE")) deleteSchedule(ex, lastId(path));
      else if (path.equals("/api/notifications") && method.equals("GET")) notifications(ex, auth, query);
      else if (path.equals("/api/notifications") && method.equals("POST")) createNotification(ex, auth);
      else if (path.equals("/api/notifications/read") && method.equals("PUT")) readNotifications(ex, auth);
      else if (path.equals("/api/notifications/mark-read") && method.equals("POST")) markNotifications(ex);
      else if (path.equals("/api/notifications/delete-multiple") && method.equals("POST")) deleteNotifications(ex);
      else if (match(path, "/api/notifications/(\\d+)/read") && method.equals("PUT")) readNotification(ex, lastId(path));
      else if (match(path, "/api/notifications/(\\d+)") && method.equals("DELETE")) deleteNotification(ex, lastId(path));
      else if (path.equals("/api/notifications") && method.equals("DELETE")) clearNotifications(ex, auth);
      else if (path.equals("/api/logs") && method.equals("GET")) logs(ex, auth);
      else if (path.equals("/api/logs") && method.equals("POST")) createLog(ex, auth);
      else if (path.equals("/api/logs/modules") && method.equals("GET")) logModules(ex);
      else if (path.equals("/api/logs/actions") && method.equals("GET")) logActions(ex);
      else send(ex, 404, error("API endpoint not found."));
    } catch (ApiException api) {
      send(ex, api.status, error(api.getMessage()));
    } catch (Exception err) {
      err.printStackTrace();
      send(ex, 500, error(err.getMessage() == null ? "Internal server error." : err.getMessage()));
    }
  }

  private void health(HttpExchange ex) throws IOException {
    String dbStatus = "ok";
    try {
      db.one("SELECT 1 AS ok");
    } catch (Exception ignored) {
      dbStatus = "degraded";
    }
    send(ex, 200, Map.of(
        "status", dbStatus.equals("ok") ? "ok" : "degraded",
        "api", "ok",
        "db", dbStatus,
        "uptime", System.nanoTime() / 1_000_000_000,
        "memoryMB", Runtime.getRuntime().totalMemory() / 1024 / 1024,
        "timestamp", Instant.now().toString()));
  }

  private void login(HttpExchange ex) throws IOException, SQLException {
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

  private void me(HttpExchange ex, Auth auth) throws IOException, SQLException {
    Map<String, Object> user = db.one("SELECT id, username, email, full_name, role, avatar_url, is_locked, failed_login_attempts, last_login, created_at FROM users WHERE id = ?", auth.userId);
    if (user == null) throw new ApiException(404, "User not found.");
    Map<String, Object> out = userDto(user);
    out.put("isLocked", user.get("isLocked"));
    out.put("failedLoginAttempts", user.get("failedLoginAttempts"));
    out.put("lastLogin", user.get("lastLogin"));
    out.put("createdAt", user.get("createdAt"));
    send(ex, 200, out);
  }

  private void changePassword(HttpExchange ex, Auth auth) throws IOException, SQLException {
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

  private void profile(HttpExchange ex, Auth auth) throws IOException, SQLException {
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

  private void forgot(HttpExchange ex) throws IOException {
    Map<String, Object> body = body(ex);
    if (str(body.get("email")).isBlank()) throw new ApiException(400, "Email is required.");
    send(ex, 200, message("If an account with that email exists, a password reset link has been sent."));
  }

  private void users(HttpExchange ex, Auth auth) throws IOException, SQLException {
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

  private void createUser(HttpExchange ex, Auth auth) throws IOException, SQLException {
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

  private void updateUser(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    admin(auth);
    Map<String, Object> body = body(ex);
    db.update("UPDATE users SET full_name = ?, email = ?, role = ?::user_role, is_active = ?, avatar_url = ? WHERE id = ?",
        body.get("fullName"), body.get("email"), body.get("role"), body.get("isActive"), body.get("avatarUrl"), id);
    send(ex, 200, message("User updated successfully."));
  }

  private void lockUser(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    admin(auth);
    boolean locked = Boolean.TRUE.equals(body(ex).get("isLocked"));
    if (locked && id == auth.userId) throw new ApiException(400, "You cannot lock your own account.");
    int rows = locked
        ? db.update("UPDATE users SET is_locked = TRUE, failed_login_attempts = 3, locked_at = NOW(), locked_by = ? WHERE id = ?", auth.userId, id)
        : db.update("UPDATE users SET is_locked = FALSE, failed_login_attempts = 0, unlocked_at = NOW(), unlocked_by = ? WHERE id = ?", auth.userId, id);
    if (rows == 0) throw new ApiException(404, "User not found.");
    send(ex, 200, message("User " + (locked ? "locked" : "unlocked") + " successfully."));
  }

  private void deleteUser(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    admin(auth);
    if (id == auth.userId) throw new ApiException(400, "You cannot delete your own account.");
    db.update("DELETE FROM users WHERE id = ?", id);
    send(ex, 204, null);
  }

  private void scripts(HttpExchange ex, Auth auth, Map<String, String> q) throws IOException, SQLException {
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
    send(ex, 200, db.rows(sql.toString(), params.toArray()));
  }

  private void categories(HttpExchange ex) throws IOException, SQLException {
    send(ex, 200, db.rows("""
        SELECT sc.*, COALESCE(COUNT(s.id), 0)::int AS script_count
        FROM script_categories sc
        LEFT JOIN scripts s ON s.category_id = sc.id AND s.is_active = TRUE
        GROUP BY sc.id ORDER BY sc.sort_order, sc.name
        """));
  }

  private void script(HttpExchange ex, int id) throws IOException, SQLException {
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

  private void updateScript(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
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

  private void updateScriptDependencies(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    edit(auth);
    ensureDependencies();
    List<Integer> ids = intList(body(ex).get("dependencyIds"));
    db.update("DELETE FROM script_dependencies WHERE script_id = ?", id);
    for (Integer dep : ids) if (dep != id) db.update("INSERT INTO script_dependencies (script_id, dependency_script_id) VALUES (?, ?) ON CONFLICT DO NOTHING", id, dep);
    send(ex, 200, Map.of("message", "Script dependencies updated.", "scriptId", id, "dependencyIds", ids));
  }

  private void deleteScript(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    edit(auth);
    db.update("UPDATE scripts SET is_active = FALSE WHERE id = ?", id);
    send(ex, 200, message("Script deleted."));
  }

  private void deleteScripts(HttpExchange ex, Auth auth) throws IOException, SQLException {
    edit(auth);
    List<Integer> ids = intList(body(ex).get("ids"));
    if (!ids.isEmpty()) db.update("UPDATE scripts SET is_active = FALSE WHERE id IN (" + placeholders(ids.size()) + ")", ids.toArray());
    send(ex, 200, Map.of("success", true, "deleted", ids.size()));
  }

  private void syncScripts(HttpExchange ex, Auth auth) throws IOException, SQLException {
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

  private void importScript(HttpExchange ex, Auth auth) throws IOException, SQLException {
    edit(auth);
    MultipartFile file = multipartFile(ex);
    if (file == null || !file.fileName.toLowerCase(Locale.ROOT).endsWith(".java")) throw new ApiException(400, "Only .java files are supported.");
    Path base = Path.of(env.value("ST_AUTOMATION_IMPORT_PATH", "scripts"));
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

  private void scriptConfiguration(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
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
    java.put("methods", javaMethods(source));
    java.put("previewLines", lines.stream().limit(80).toList());
    java.put("lineCount", lines.size());
    java.put("fileSizeBytes", sourceAvailable ? Files.size(path) : 0);
    java.put("lastModifiedAt", sourceAvailable ? Files.getLastModifiedTime(path).toInstant().toString() : null);
    java.put("sourceAvailable", sourceAvailable);
    java.put("sourceReadError", sourceAvailable ? null : "Script file is not available on disk for path \"" + str(row.get("filePath")) + "\".");
    row.put("resolvedFilePath", path.toString());
    row.put("createdBy", row.get("createdByName"));
    row.put("methodName", firstNonBlank(str(row.get("methodName")), inferPrimaryMethod(source), "-"));
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

  private Map<String, Object> scriptExecutionSummary(int scriptId) throws SQLException {
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

  private int percent(double numerator, double denominator) {
    if (denominator <= 0) return 0;
    return (int) Math.round((numerator / denominator) * 100.0);
  }

  private List<Map<String, Object>> scriptArtifacts(int scriptId) throws SQLException {
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

  private Map<String, List<Map<String, Object>>> scriptResources(Map<String, Object> script, Path scriptPath, String source) {
    List<Map<String, Object>> javaConfigs = new ArrayList<>();
    List<Map<String, Object>> jsonFiles = new ArrayList<>();
    List<Map<String, Object>> attachments = new ArrayList<>();
    List<Map<String, Object>> dataFiles = new ArrayList<>();
    Path workspace = automationWorkspace();

    if (scriptPath != null) {
      javaConfigs.add(resource("java_config", scriptPath.getFileName().toString(), scriptPath, Files.exists(scriptPath), "Script Java File"));
    }

    List<Map<String, Object>> scriptJavaConfigs = new ArrayList<>();
    Map<String, Object> baseConfig = null;
    for (String imp : javaImports(source)) {
      String simple = imp.substring(imp.lastIndexOf('.') + 1);
      Path resolved = resolveImportPath(workspace, imp);
      if (resolved == null) continue;
      if (isBaseConfigImport(simple)) {
        baseConfig = resource("java_config", imp, resolved, Files.exists(resolved), "Base Config");
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
    if (baseConfig != null) javaConfigs.add(baseConfig);
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

  private boolean isBaseConfigImport(String simpleName) {
    return "baseconfig".equalsIgnoreCase(simpleName);
  }

  private boolean isScriptJavaConfigImport(String simpleName) {
    String lower = simpleName == null ? "" : simpleName.toLowerCase(Locale.ROOT);
    return lower.contains("config")
        && !"baseconfig".equals(lower)
        && !"htmlpath".equals(lower)
        && !lower.contains("common");
  }

  private void collectReferencedResources(String source, Path contextPath, Path workspace, List<Map<String, Object>> jsonFiles, List<Map<String, Object>> attachments, String jsonLogicalName, boolean includeJson) {
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

  private boolean isJsonReference(String value) {
    return value != null && value.trim().toLowerCase(Locale.ROOT).endsWith(".json");
  }

  private void collectJsonAttachments(Path jsonPath, Path workspace, List<Map<String, Object>> attachments) {
    try {
      Object root = JSON.readValue(Files.readString(jsonPath), ANY);
      collectJsonAttachmentValues(root, "", jsonPath, workspace, attachments);
    } catch (Exception ignored) {}
  }

  private void collectJsonAttachmentValues(Object value, String key, Path jsonPath, Path workspace, List<Map<String, Object>> attachments) {
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

  private boolean shouldResolveAsFolder(String key, String value) {
    String lowerKey = key == null ? "" : key.toLowerCase(Locale.ROOT);
    String lowerValue = value == null ? "" : value.toLowerCase(Locale.ROOT);
    return lowerValue.endsWith("/") || lowerValue.endsWith("\\")
        || lowerKey.contains("folder")
        || lowerKey.contains("directory")
        || lowerKey.contains("location")
        || lowerKey.contains("path");
  }

  private void addFolderAttachments(String reference, Path folder, List<Map<String, Object>> attachments) {
    String prefix = reference.endsWith("/") || reference.endsWith("\\") ? reference : reference + "/";
    try (var stream = Files.walk(folder, 5)) {
      stream.filter(Files::isRegularFile)
          .forEach(path -> attachments.add(resource("attachment", prefix + folder.relativize(path), path, true, "JSON Folder File")));
    } catch (Exception ignored) {}
  }

  private Path resolveDirectoryReference(Path contextPath, Path workspace, String reference) {
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

  private boolean looksLikeFileReference(String value) {
    if (value == null) return false;
    String trimmed = value.trim();
    if (trimmed.isBlank() || isUrlOrEmail(trimmed)) return false;
    String leaf = trimmed.replace('\\', '/');
    leaf = leaf.substring(leaf.lastIndexOf('/') + 1);
    Matcher fileName = Pattern.compile("^[^\\s]+\\.([A-Za-z0-9]{1,8})$").matcher(leaf);
    return fileName.matches() && Pattern.compile("[A-Za-z]").matcher(fileName.group(1)).find();
  }

  private boolean isUrlOrEmail(String value) {
    String lower = value == null ? "" : value.toLowerCase(Locale.ROOT);
    return lower.contains("://") || lower.startsWith("mailto:") || lower.matches("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$");
  }

  private List<Map<String, Object>> editableFiles(Map<String, List<Map<String, Object>>> resources, Path scriptPath, boolean scriptExists) {
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

  private int coreResourcePriority(Map<String, Object> resource) {
    Object metadataValue = resource.get("metadata");
    String logicalName = metadataValue instanceof Map<?, ?> metadata ? str(metadata.get("logicalName")).toLowerCase(Locale.ROOT) : "";
    if ("script java file".equals(logicalName)) return 10;
    if ("script java config file".equals(logicalName)) return 20;
    if ("script json".equals(logicalName)) return 30;
    if ("base config".equals(logicalName)) return 40;
    return 100;
  }

  private Map<String, Object> editableFile(Path path, String fileType, String reference, String sourceType) {
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

  private Map<String, Object> resource(String type, String reference, Path resolved, boolean exists, String logicalName) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("type", type);
    out.put("reference", reference);
    out.put("resolvedPath", resolved == null ? null : resolved.toString());
    out.put("existsOnDisk", exists);
    out.put("sourceKind", "parser");
    out.put("metadata", Map.of("logicalName", logicalName));
    return out;
  }

  private List<Map<String, Object>> dedupeResources(List<Map<String, Object>> resources) {
    Map<String, Map<String, Object>> byKey = new LinkedHashMap<>();
    for (Map<String, Object> resource : resources) {
      String key = firstNonBlank(str(resource.get("resolvedPath")), str(resource.get("reference"))).toLowerCase(Locale.ROOT);
      if (!key.isBlank()) byKey.putIfAbsent(key, resource);
    }
    return new ArrayList<>(byKey.values());
  }

  private void fileContent(HttpExchange ex, Map<String, String> q) throws IOException {
    Path path = Path.of(q.getOrDefault("path", ""));
    if (!Files.exists(path)) throw new ApiException(404, "File not found.");
    send(ex, 200, Map.of("path", path.toString(), "fileName", path.getFileName().toString(), "fileType", path.toString().endsWith(".json") ? "json" : "java", "fileSizeBytes", Files.size(path), "lastModifiedAt", Files.getLastModifiedTime(path).toInstant().toString(), "content", Files.readString(path)));
  }

  private void updateFile(HttpExchange ex, Auth auth, int scriptId) throws IOException, SQLException {
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

  private void configurationChanges(HttpExchange ex, Auth auth, int scriptId, Map<String, String> q) throws IOException, SQLException {
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

  private void configurationChange(HttpExchange ex, Auth auth, int scriptId, int changeId) throws IOException, SQLException {
    requireScriptAccess(auth, scriptId);
    Map<String, Object> row = db.one("""
        SELECT id, script_id, file_path, file_name, file_type, changed_by, changed_at, change_summary, previous_content, updated_content
        FROM script_configuration_changes
        WHERE script_id = ? AND id = ?
        """, scriptId, changeId);
    if (row == null) throw new ApiException(404, "Change not found.");
    send(ex, 200, row);
  }

  private Map<String, Object> changeSummary(String before, String after) {
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

  private void attachment(HttpExchange ex, Map<String, String> q) throws IOException {
    Path path = Path.of(q.getOrDefault("path", ""));
    if (!Files.exists(path)) throw new ApiException(404, "File not found.");
    Headers h = ex.getResponseHeaders();
    h.add("Content-Disposition", ("download".equals(q.get("mode")) ? "attachment" : "inline") + "; filename=\"" + path.getFileName() + "\"");
    sendBytes(ex, 200, Files.readAllBytes(path));
  }

  private void assignments(HttpExchange ex, Auth auth) throws IOException, SQLException {
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

  private void userAssignments(HttpExchange ex, Auth auth, int userId) throws IOException, SQLException {
    admin(auth);
    send(ex, 200, Map.of("userId", userId, "scriptIds", db.rows("SELECT script_id FROM script_assignments WHERE user_id = ? ORDER BY script_id", userId).stream().map(r -> r.get("scriptId")).toList()));
  }

  private void updateAssignments(HttpExchange ex, Auth auth, int userId) throws IOException, SQLException {
    admin(auth);
    List<Integer> ids = intList(body(ex).get("scriptIds"));
    db.update("DELETE FROM script_assignments WHERE user_id = ?", userId);
    for (Integer sid : ids) db.update("INSERT INTO script_assignments (user_id, script_id, assigned_by) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", userId, sid, auth.userId);
    send(ex, 200, Map.of("success", true, "userId", userId, "assignedCount", ids.size()));
  }

  private void suites(HttpExchange ex, Auth auth) throws IOException, SQLException {
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

  private void suite(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    Map<String, Object> suite = db.one("SELECT ts.*, u.full_name AS created_by_name FROM test_suites ts LEFT JOIN users u ON ts.created_by = u.id WHERE ts.id = ?", id);
    if (suite == null) throw new ApiException(404, "Suite not found.");
    suite.put("scripts", db.rows("""
        SELECT s.id, s.name, s.class_name, sc.name AS category_name, sc.color AS category_color, ss.execution_order
        FROM suite_scripts ss JOIN scripts s ON ss.script_id = s.id JOIN script_categories sc ON s.category_id = sc.id
        WHERE ss.suite_id = ? ORDER BY ss.execution_order
        """, id));
    send(ex, 200, suite);
  }

  private void createSuite(HttpExchange ex, Auth auth) throws IOException, SQLException {
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

  private void updateSuite(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
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

  private void duplicateSuite(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
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

  private void deleteSuite(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    admin(auth);
    db.update("DELETE FROM test_suites WHERE id = ?", id);
    send(ex, 200, message("Suite deleted."));
  }

  private void run(HttpExchange ex, Auth auth) throws IOException, SQLException {
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

  private void stopRun(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    edit(auth);
    Process p = activeProcesses.remove(id);
    if (p != null) p.destroy();
    db.update("UPDATE execution_runs SET status = 'stopped'::run_status, completed_at = NOW() WHERE id = ?", id);
    db.update("UPDATE execution_results SET status = 'skipped'::result_status WHERE run_id = ? AND status IN ('queued','running')", id);
    send(ex, 200, message("Execution stopped."));
  }

  private void runs(HttpExchange ex, Auth auth, Map<String, String> q) throws IOException, SQLException {
    List<Object> params = new ArrayList<>();
    String where = "WHERE 1=1";
    if (q.containsKey("status") && !q.get("status").isBlank()) { where += " AND er.status = ?::run_status"; params.add(q.get("status")); }
    if ("tester".equals(auth.role)) {
      where += " AND EXISTS (SELECT 1 FROM execution_results eres WHERE eres.run_id = er.id AND eres.script_id IN (SELECT script_id FROM script_assignments WHERE user_id = ?))";
      params.add(auth.userId);
    }
    params.add(Integer.parseInt(q.getOrDefault("limit", "50")));
    params.add(Integer.parseInt(q.getOrDefault("offset", "0")));
    List<Map<String, Object>> rows = db.rows("SELECT er.*, u.full_name AS triggered_by_name FROM execution_runs er LEFT JOIN users u ON er.triggered_by = u.id " + where + " ORDER BY er.created_at DESC LIMIT ? OFFSET ?", params.toArray());
    for (Map<String, Object> row : rows) {
      row.put("runMetadata", enrichRunMetadata(row));
      shapeRunResponse(row);
    }
    send(ex, 200, rows);
  }

  private void runDetails(HttpExchange ex, Auth auth, int id) throws IOException, SQLException {
    Map<String, Object> run = db.one("SELECT er.*, u.full_name AS triggered_by_name FROM execution_runs er LEFT JOIN users u ON er.triggered_by = u.id WHERE er.id = ?", id);
    if (run == null) throw new ApiException(404, "Run not found.");
    if ("tester".equals(auth.role)) {
      int assigned = intValue(db.one("""
          SELECT COUNT(*)::int AS count
          FROM execution_results eres
          WHERE eres.run_id = ? AND eres.script_id IN (SELECT script_id FROM script_assignments WHERE user_id = ?)
          """, id, auth.userId).get("count"), 0);
      if (assigned == 0) throw new ApiException(403, "Access denied: You are not assigned to any scripts in this execution run.");
    }
    List<Map<String, Object>> results = "tester".equals(auth.role)
        ? db.rows("""
            SELECT eres.*, s.name AS script_name, s.class_name
            FROM execution_results eres
            JOIN scripts s ON eres.script_id = s.id
            WHERE eres.run_id = ? AND eres.script_id IN (SELECT script_id FROM script_assignments WHERE user_id = ?)
            ORDER BY eres.id
            """, id, auth.userId)
        : db.rows("SELECT eres.*, s.name AS script_name, s.class_name FROM execution_results eres JOIN scripts s ON eres.script_id = s.id WHERE eres.run_id = ? ORDER BY eres.id", id);
    run.put("results", results);
    run.put("runMetadata", enrichRunMetadata(run));
    shapeRunResponse(run);
    send(ex, 200, run);
  }

  private void shapeRunResponse(Map<String, Object> run) {
    Object displayName = firstNonBlank(str(run.get("triggeredByName")), str(run.get("username")), "System");
    run.put("triggeredBy", displayName);
  }

  private void stats(HttpExchange ex, Auth auth) throws IOException, SQLException {
    boolean tester = "tester".equals(auth.role);
    Object[] userParam = tester ? new Object[]{auth.userId} : new Object[]{};
    String scriptFilter = tester ? " AND id IN (SELECT script_id FROM script_assignments WHERE user_id = ?)" : "";
    String runFilter = tester ? " WHERE EXISTS (SELECT 1 FROM execution_results eres WHERE eres.run_id = er.id AND eres.script_id IN (SELECT script_id FROM script_assignments WHERE user_id = ?))" : "";
    String andOrWhere = runFilter.isBlank() ? " WHERE " : " AND ";
    Object[] historyParams = tester ? new Object[]{auth.userId, auth.userId} : new Object[]{};

    Number totalScripts = (Number) db.one("SELECT COUNT(*)::int AS count FROM scripts WHERE is_active = TRUE" + scriptFilter, userParam).get("count");
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
        """, userParam);
    send(ex, 200, Map.of("totalScripts", totalScripts, "totalRuns", totalRuns, "recentRuns", recentRuns, "passRate", passRate, "runningCount", running, "recentHistory", recentHistory, "categoryStats", categoryStats));
  }

  private void executionLogs(HttpExchange ex, int runId) throws IOException, SQLException {
    send(ex, 200, db.rows("SELECT id, run_id, log_level AS level, message, timestamp FROM execution_logs WHERE run_id = ? ORDER BY timestamp ASC, id ASC", runId));
  }

  private void artifacts(HttpExchange ex, int runId) throws IOException, SQLException {
    List<Map<String, Object>> rows = artifactRows(runId);
    List<Map<String, Object>> visible = visibleArtifacts(runId, rows);
    if (visible.isEmpty()) {
      ensureOutputArtifactsForRun(runId);
      visible = visibleArtifacts(runId, artifactRows(runId));
    }
    send(ex, 200, visible);
  }

  private List<Map<String, Object>> artifactRows(int runId) throws SQLException {
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

  private List<Map<String, Object>> visibleArtifacts(int runId, List<Map<String, Object>> rows) throws SQLException {
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

  private List<Map<String, Object>> oneHtmlPdfPair(List<Map<String, Object>> artifacts) {
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

  private String artifactBaseName(String fileName) {
    String name = Path.of(fileName).getFileName().toString();
    int dot = name.lastIndexOf('.');
    return dot > 0 ? name.substring(0, dot) : name;
  }

  private void artifactDownload(HttpExchange ex, int id) throws IOException, SQLException {
    Map<String, Object> artifact = db.one("SELECT * FROM execution_artifacts WHERE id = ?", id);
    if (artifact == null || artifact.get("storedPath") == null) throw new ApiException(404, "Artifact not found.");
    Path path = Path.of(str(artifact.get("storedPath")));
    if (!Files.exists(path)) throw new ApiException(404, "Artifact file not found on disk.");
    ex.getResponseHeaders().add("Content-Disposition", "attachment; filename=\"" + artifact.get("fileName") + "\"");
    sendBytes(ex, 200, Files.readAllBytes(path));
  }

  private void mailArtifacts(HttpExchange ex) throws IOException, SQLException {
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

  private void globalLogs(HttpExchange ex, Map<String, String> q) throws IOException, SQLException {
    int limit = Integer.parseInt(q.getOrDefault("limit", "200"));
    int offset = Integer.parseInt(q.getOrDefault("offset", "0"));
    Number total = (Number) db.one("SELECT COUNT(*)::int AS count FROM app_logs").get("count");
    send(ex, 200, Map.of("data", db.rows("SELECT * FROM app_logs ORDER BY timestamp DESC LIMIT ? OFFSET ?", limit, offset), "summary", Map.of("total", total), "meta", Map.of("total", total, "limit", limit, "offset", offset)));
  }

  private void deleteGlobalLog(HttpExchange ex, int id) throws IOException, SQLException {
    db.update("DELETE FROM app_logs WHERE id = ?", id);
    send(ex, 200, Map.of("success", true));
  }

  private void deleteGlobalLogs(HttpExchange ex) throws IOException, SQLException {
    List<Integer> ids = intList(body(ex).get("ids"));
    if (!ids.isEmpty()) db.update("DELETE FROM app_logs WHERE id IN (" + placeholders(ids.size()) + ")", ids.toArray());
    send(ex, 200, Map.of("success", true));
  }

  private void createSchedule(HttpExchange ex, Auth auth) throws IOException, SQLException {
    edit(auth);
    Map<String, Object> b = body(ex);
    boolean oneTime = Boolean.TRUE.equals(b.getOrDefault("isOneTime", false));
    Object nextRunAt = nextRunAt(str(b.get("cronExpression")), oneTime);
    Map<String, Object> created = db.one("INSERT INTO scheduled_runs (name, suite_id, script_ids, cron_expression, environment, description, is_one_time, next_run_at, created_by) VALUES (?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?) RETURNING *",
        b.get("name"), b.get("suiteId"), b.containsKey("scriptIds") ? json(b.get("scriptIds")) : null, b.get("cronExpression"), b.getOrDefault("environment", "local"), b.get("description"), oneTime, nextRunAt, auth.userId);
    send(ex, 201, created);
  }

  private void schedules(HttpExchange ex) throws IOException, SQLException {
    send(ex, 200, db.rows("SELECT sr.*, u.full_name AS created_by_name FROM scheduled_runs sr LEFT JOIN users u ON sr.created_by = u.id ORDER BY sr.created_at DESC"));
  }

  private void updateSchedule(HttpExchange ex, int id) throws IOException, SQLException {
    Map<String, Object> b = body(ex);
    Object nextRunAt = b.containsKey("cronExpression") || b.containsKey("isOneTime")
        ? nextRunAt(str(b.get("cronExpression")), Boolean.TRUE.equals(b.getOrDefault("isOneTime", false)))
        : null;
    db.update("UPDATE scheduled_runs SET name = COALESCE(?, name), cron_expression = COALESCE(?, cron_expression), is_active = COALESCE(?, is_active), environment = COALESCE(?, environment), description = COALESCE(?, description), is_one_time = COALESCE(?, is_one_time), next_run_at = COALESCE(?, next_run_at) WHERE id = ?",
        b.get("name"), b.get("cronExpression"), b.get("isActive"), b.get("environment"), b.get("description"), b.get("isOneTime"), nextRunAt, id);
    send(ex, 200, message("Schedule updated."));
  }

  private void deleteSchedule(HttpExchange ex, int id) throws IOException, SQLException {
    db.update("DELETE FROM scheduled_runs WHERE id = ?", id);
    send(ex, 200, message("Schedule deleted."));
  }

  private void notifications(HttpExchange ex, Auth auth, Map<String, String> q) throws IOException, SQLException {
    int days = Integer.parseInt(q.getOrDefault("days", "30"));
    send(ex, 200, db.rows("SELECT * FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND created_at >= NOW() - (? || ' days')::interval ORDER BY created_at DESC LIMIT 200", auth.userId, days));
  }

  private void createNotification(HttpExchange ex, Auth auth) throws IOException, SQLException {
    Map<String, Object> b = body(ex);
    Object targetUser = b.get("user_id") == null ? auth.userId : b.get("user_id");
    send(ex, 200, db.one("INSERT INTO notifications (user_id, severity, summary, detail, icon, source, category, action_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at",
        targetUser, b.get("severity"), b.get("summary"), b.get("detail"), b.get("icon"), b.getOrDefault("source", "System"), b.getOrDefault("category", "General"), b.get("action_url")));
  }

  private void readNotification(HttpExchange ex, int id) throws IOException, SQLException { db.update("UPDATE notifications SET is_read = TRUE WHERE id = ?", id); send(ex, 200, Map.of("success", true)); }
  private void deleteNotification(HttpExchange ex, int id) throws IOException, SQLException { db.update("DELETE FROM notifications WHERE id = ?", id); send(ex, 200, Map.of("success", true)); }
  private void readNotifications(HttpExchange ex, Auth auth) throws IOException, SQLException { db.update("UPDATE notifications SET is_read = TRUE WHERE user_id = ? OR user_id IS NULL", auth.userId); send(ex, 200, Map.of("success", true)); }
  private void clearNotifications(HttpExchange ex, Auth auth) throws IOException, SQLException { int n = db.update("DELETE FROM notifications WHERE user_id = ? OR user_id IS NULL", auth.userId); send(ex, 200, Map.of("success", true, "deleted", n)); }
  private void markNotifications(HttpExchange ex) throws IOException, SQLException { updateNotificationIds(ex, "UPDATE notifications SET is_read = TRUE WHERE id IN (", "updated"); }
  private void deleteNotifications(HttpExchange ex) throws IOException, SQLException { updateNotificationIds(ex, "DELETE FROM notifications WHERE id IN (", "deleted"); }

  private void updateNotificationIds(HttpExchange ex, String prefix, String countKey) throws IOException, SQLException {
    List<Integer> ids = intList(body(ex).get("ids"));
    if (ids.isEmpty()) throw new ApiException(400, "Invalid IDs");
    db.update(prefix + placeholders(ids.size()) + ")", ids.toArray());
    send(ex, 200, Map.of("success", true, countKey, ids.size()));
  }

  private void logs(HttpExchange ex, Auth auth) throws IOException, SQLException { edit(auth); send(ex, 200, db.rows("SELECT * FROM app_logs ORDER BY timestamp DESC LIMIT 300")); }
  private void createLog(HttpExchange ex, Auth auth) throws IOException, SQLException {
    Map<String, Object> b = body(ex);
    db.update("INSERT INTO app_logs (severity, module, action, status, message, user_id, username, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb)",
        b.getOrDefault("severity", b.getOrDefault("level", "INFO")), b.getOrDefault("module", "frontend"), b.get("action"), b.get("status"), b.getOrDefault("message", b.getOrDefault("detail", "")), auth.userId, auth.username, b.containsKey("metadata") ? json(b.get("metadata")) : null);
    send(ex, 200, Map.of("success", true));
  }
  private void logModules(HttpExchange ex) throws IOException, SQLException { send(ex, 200, db.rows("SELECT LOWER(COALESCE(NULLIF(module,''),'application')) AS value, LOWER(COALESCE(NULLIF(module,''),'application')) AS label, COUNT(*)::int AS count FROM app_logs GROUP BY value ORDER BY count DESC, value LIMIT 200")); }
  private void logActions(HttpExchange ex) throws IOException, SQLException { send(ex, 200, db.rows("SELECT action AS value, action AS label, COUNT(*)::int AS count FROM app_logs WHERE action IS NOT NULL AND action <> '' GROUP BY action ORDER BY count DESC, action LIMIT 300")); }

  private void startExecution(int runId, String runName, String testngXml, List<Map<String, Object>> scripts) {
    CompletableFuture.runAsync(() -> {
      StringBuilder out = new StringBuilder();
      Path workspace = null;
      try {
        workspace = resolveExecutionWorkspace(runId);
        Path suiteFile = workspace.resolve("noesis-testng-run-" + runId + ".xml");
        Files.createDirectories(workspace);
        if (!Files.exists(workspace.resolve("pom.xml"))) throw new IOException("Automation workspace is missing pom.xml: " + workspace);
        Files.writeString(suiteFile, testngXml);
        db.update("UPDATE execution_runs SET run_metadata = COALESCE(run_metadata, '{}'::jsonb) || ?::jsonb WHERE id = ?",
            json(Map.of(
                "executionSource", env.value("ST_AUTOMATION_SOURCE", "git"),
                "gitRepoUrl", gitRepositoryUrl(),
                "gitRepoName", gitRepositoryName(),
                "gitBranch", env.value("ST_AUTOMATION_GIT_BRANCH", "main"),
                "appUrl", env.value("ST_AUTOMATION_APP_URL", ""),
                "workspacePath", workspace.toString(),
                "suiteFilePath", suiteFile.toString(),
                "suiteFileName", suiteFile.getFileName().toString(),
                "reportsDirectory", surefireReportsDirectory(workspace).toString(),
                "startedAt", Instant.now().toString())), runId);
        logExecution(runId, "INFO", "Execution started for " + runName + ".");
        logExecution(runId, "INFO", "Workspace: " + workspace.toAbsolutePath());
        db.update("UPDATE execution_results SET status = 'running'::result_status, started_at = NOW() WHERE run_id = ?", runId);
        List<String> command = mavenCommand();
        command.add("test");
        command.add("-Dsurefire.suiteXmlFiles=" + suiteFile.toAbsolutePath());
        logExecution(runId, "INFO", "Command: " + String.join(" ", command));
        ProcessBuilder pb = new ProcessBuilder(command);
        pb.directory(workspace.toFile());
        if (!env.value("MAVEN_HOME", "").isBlank()) pb.environment().put("MAVEN_HOME", env.value("MAVEN_HOME", ""));
        pb.redirectErrorStream(true);
        Process p = pb.start();
        activeProcesses.put(runId, p);
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
          String line;
          while ((line = reader.readLine()) != null) {
            out.append(line).append(System.lineSeparator());
            logExecution(runId, severity(line), line);
          }
        }
        long timeoutMinutes = Long.parseLong(env.value("EXECUTION_TIMEOUT_MINUTES", "90"));
        boolean finished = p.waitFor(timeoutMinutes, TimeUnit.MINUTES);
        if (!finished) {
          p.destroyForcibly();
          throw new IOException("Execution timed out after " + timeoutMinutes + " minutes.");
        }
        int exit = p.exitValue();
        activeProcesses.remove(runId);
        ResultSummary summary = finalSummary(exit, out.toString(), workspace, scripts.size());
        String status = exit == 0 && summary.failed == 0 && summary.errors == 0 ? "passed" : "failed";
        createExecutionOutputArtifacts(runId, runName, status, summary, out.toString());
        int artifactCount = collectExecutionArtifacts(runId, workspace, scripts);
        db.update("UPDATE execution_runs SET status = ?::run_status, passed_count = ?, failed_count = ?, error_count = ?, skipped_count = ?, completed_at = NOW(), duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at))::int * 1000, run_metadata = COALESCE(run_metadata, '{}'::jsonb) || ?::jsonb WHERE id = ?",
            status, summary.passed, summary.failed, summary.errors, summary.skipped,
            json(Map.of("executionSource", env.value("ST_AUTOMATION_SOURCE", "git"), "workspacePath", workspace.toString(), "finalStatus", status, "exitCode", exit, "artifactCount", artifactCount,
                "completedAt", Instant.now().toString(), "resultSummary", Map.of("passed", summary.passed, "failed", summary.failed, "errors", summary.errors, "skipped", summary.skipped))), runId);
        db.update("UPDATE execution_results SET status = ?::result_status, completed_at = NOW(), log_output = ? WHERE run_id = ?", status, out.toString(), runId);
        logExecution(runId, exit == 0 ? "INFO" : "ERROR", "Execution completed with status: " + status + ".");
        sendExecutionCompletionMail(runId, runName, status, summary, null);
      } catch (Exception e) {
        activeProcesses.remove(runId);
        try {
          db.update("UPDATE execution_runs SET status = 'error'::run_status, completed_at = NOW(), error_count = total_scripts WHERE id = ?", runId);
          db.update("UPDATE execution_results SET status = 'error'::result_status, completed_at = NOW(), error_message = ? WHERE run_id = ?", e.getMessage(), runId);
          logExecution(runId, "ERROR", "Execution failed: " + e.getMessage());
          sendExecutionCompletionMail(runId, runName, "error", new ResultSummary(0, scripts.size(), 0, 0), e.getMessage());
        } catch (Exception ignored) {}
      }
    });
  }

  private void logExecution(int runId, String severity, String detail) throws SQLException {
    db.update("INSERT INTO execution_logs (run_id, log_level, message, detailed_description, source_component, timestamp) VALUES (?, ?::log_level, ?, ?, 'java-execution-runner', NOW())", runId, severity, trim(detail, 4000), detail);
  }

  private List<String> mavenCommand() {
    String home = env.value("MAVEN_HOME", "").trim();
    if (!home.isBlank()) {
      Path mvn = Path.of(home, "bin", isWindows() ? "mvn.cmd" : "mvn");
      if (Files.exists(mvn)) return new ArrayList<>(List.of(mvn.toString()));
    }
    return new ArrayList<>(List.of(isWindows() ? "mvn.cmd" : "mvn"));
  }

  private boolean isWindows() {
    return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
  }

  private Path resolveExecutionWorkspace(int runId) throws IOException, InterruptedException, SQLException {
    if (!env.value("ST_AUTOMATION_SOURCE", "git").equalsIgnoreCase("git")) {
      return Path.of(env.value("ST_AUTOMATION_PATH", "scripts"));
    }
    Path cache = Path.of(env.value("ST_AUTOMATION_GIT_CACHE_PATH", env.value("ST_AUTOMATION_PATH", "scripts")));
    String repo = env.value("ST_AUTOMATION_GIT_REPO_URL", "").trim();
    String branch = env.value("ST_AUTOMATION_GIT_BRANCH", "main").trim();
    if (repo.isBlank()) {
      logExecution(runId, "WARN", "ST_AUTOMATION_GIT_REPO_URL is not configured. Using existing git cache: " + cache);
      return cache;
    }
    Files.createDirectories(cache.getParent());
    if (!Files.exists(cache.resolve(".git"))) {
      logExecution(runId, "INFO", "Cloning automation repository: " + repo);
      runCommand(runId, cache.getParent(), "git", "clone", "--depth", "1", repo, cache.toString());
    } else {
      logExecution(runId, "INFO", "Fetching latest automation repository changes.");
      runCommand(runId, cache, "git", "fetch", "origin", "--prune", "--depth", "1");
      if (!branch.isBlank()) {
        runCommand(runId, cache, "git", "checkout", "-B", branch, "origin/" + branch);
        runCommand(runId, cache, "git", "reset", "--hard", "origin/" + branch);
      }
    }
    return cache;
  }

  private Path resolveSyncWorkspace() throws IOException, InterruptedException {
    if (!env.value("ST_AUTOMATION_SOURCE", "git").equalsIgnoreCase("git")) {
      return Path.of(env.value("ST_AUTOMATION_PATH", "scripts"));
    }
    Path cache = Path.of(env.value("ST_AUTOMATION_GIT_CACHE_PATH", env.value("ST_AUTOMATION_PATH", "scripts")));
    String repo = env.value("ST_AUTOMATION_GIT_REPO_URL", "").trim();
    String branch = env.value("ST_AUTOMATION_GIT_BRANCH", "main").trim();
    if (repo.isBlank()) return cache;
    Files.createDirectories(cache.getParent());
    if (!Files.exists(cache.resolve(".git"))) {
      runPlainCommand(cache.getParent(), "git", "clone", "--depth", "1", repo, cache.toString());
    } else {
      runPlainCommand(cache, "git", "fetch", "origin", "--prune", "--depth", "1");
      if (!branch.isBlank()) {
        runPlainCommand(cache, "git", "checkout", "-B", branch, "origin/" + branch);
        runPlainCommand(cache, "git", "reset", "--hard", "origin/" + branch);
      }
    }
    return cache;
  }

  private void runCommand(int runId, Path cwd, String... command) throws IOException, InterruptedException, SQLException {
    ProcessBuilder pb = new ProcessBuilder(command);
    pb.directory(cwd.toFile());
    pb.redirectErrorStream(true);
    Process p = pb.start();
    StringBuilder output = new StringBuilder();
    try (BufferedReader reader = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
      String line;
      while ((line = reader.readLine()) != null) output.append(line).append(System.lineSeparator());
    }
    int exit = p.waitFor();
    if (!output.isEmpty()) logExecution(runId, exit == 0 ? "INFO" : "ERROR", output.toString().trim());
    if (exit != 0) throw new IOException("Command failed (" + String.join(" ", command) + "): " + output);
  }

  private void runPlainCommand(Path cwd, String... command) throws IOException, InterruptedException {
    ProcessBuilder pb = new ProcessBuilder(command);
    pb.directory(cwd.toFile());
    pb.redirectErrorStream(true);
    Process p = pb.start();
    String output;
    try (BufferedReader reader = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
      StringBuilder out = new StringBuilder();
      String line;
      while ((line = reader.readLine()) != null) out.append(line).append(System.lineSeparator());
      output = out.toString();
    }
    int exit = p.waitFor();
    if (exit != 0) throw new IOException("Command failed (" + String.join(" ", command) + "): " + output);
  }

  private List<Path> javaFiles(Path root) throws IOException {
    List<Path> files = new ArrayList<>();
    List<Path> stack = new ArrayList<>(List.of(root));
    Set<String> skipDirs = Set.of(".git", "target", "node_modules", "bin", "obj", "dist", "build", ".cache");
    while (!stack.isEmpty()) {
      Path dir = stack.remove(stack.size() - 1);
      try (var entries = Files.list(dir)) {
        for (Path entry : entries.toList()) {
          if (Files.isDirectory(entry)) {
            if (!skipDirs.contains(entry.getFileName().toString().toLowerCase(Locale.ROOT))) stack.add(entry);
          } else if (entry.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".java")) {
            files.add(entry);
          }
        }
      }
    }
    return files;
  }

  private boolean isConfigJava(String fileName, String source) {
    String cleaned = stripJavaComments(source);
    boolean hasTestAnnotation = Pattern.compile("@\\s*(Test|TestMetadata|ScriptMetadata)\\b").matcher(cleaned).find();
    String lower = fileName.toLowerCase(Locale.ROOT);
    return !hasTestAnnotation && (lower.contains("config") || lower.contains("configuration"));
  }

  private String stripJavaComments(String source) {
    return (source == null ? "" : source).replaceAll("/\\*[\\s\\S]*?\\*/", " ").replaceAll("//[^\\r\\n]*", "");
  }

  private int collectExecutionArtifacts(int runId, Path workspace, List<Map<String, Object>> scripts) {
    int before = 0;
    try { before = intValue(db.one("SELECT COUNT(*)::int AS count FROM execution_artifacts WHERE run_id = ?", runId).get("count"), 0); } catch (Exception ignored) {}
    Path surefire = workspace.resolve("target").resolve("surefire-reports");
    Path runSurefire = surefire.resolve("run-" + runId);
    Path scanRoot = Files.isDirectory(runSurefire) ? runSurefire : surefire;
    List<Path> candidates = new ArrayList<>();
    if (Files.isDirectory(surefire)) {
      try (var stream = Files.walk(scanRoot, 1)) {
        stream.filter(Files::isRegularFile)
            .filter(this::isReportArtifact)
            .forEach(candidates::add);
      } catch (Exception e) {
        try { logExecution(runId, "WARN", "Could not scan report artifacts: " + e.getMessage()); } catch (Exception ignored) {}
      }
    }
    for (Path candidate : candidates) {
      try {
        if (Files.isRegularFile(candidate)) saveArtifact(runId, scriptIdForArtifact(candidate, scripts), artifactType(candidate), candidate);
      } catch (Exception e) {
        try { logExecution(runId, "WARN", "Could not capture artifact " + candidate + ": " + e.getMessage()); } catch (Exception ignored) {}
      }
    }
    try {
      int after = intValue(db.one("SELECT COUNT(*)::int AS count FROM execution_artifacts WHERE run_id = ?", runId).get("count"), before);
      return Math.max(0, after - before);
    } catch (Exception ignored) { return 0; }
  }

  private boolean isReportArtifact(Path path) {
    String name = path.getFileName().toString().toLowerCase(Locale.ROOT);
    return name.endsWith(".html") || name.endsWith(".htm") || name.endsWith(".pdf");
  }

  private Object scriptIdForArtifact(Path path, List<Map<String, Object>> scripts) {
    String name = path.getFileName().toString().toLowerCase(Locale.ROOT);
    for (Map<String, Object> script : scripts) {
      String scriptName = str(script.get("name")).toLowerCase(Locale.ROOT);
      if (!scriptName.isBlank() && name.contains(scriptName)) return script.get("id");
    }
    return null;
  }

  private void saveArtifact(int runId, Object scriptId, String type, Path source) throws IOException, SQLException {
    if (!Files.exists(source) || !Files.isRegularFile(source)) return;
    Path dir = reportsDirectory(runId);
    Files.createDirectories(dir);
    String fileName = source.getFileName().toString();
    Path stored = dir.resolve(fileName);
    if (!source.toAbsolutePath().normalize().equals(stored.toAbsolutePath().normalize())) {
      Files.copy(source, stored, StandardCopyOption.REPLACE_EXISTING);
    }
    db.update("""
        INSERT INTO execution_artifacts (run_id, script_id, artifact_type, file_name, stored_path, file_size_bytes, mime_type)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """, runId, scriptId, type, fileName, stored.toString(), Files.size(stored), mimeType(stored));
  }

  private Path reportsDirectory(int runId) {
    Path base = Path.of(env.value("ST_AUTOMATION_REPORTS_PATH", env.value("ST_AUTOMATION_PATH", "scripts") + File.separator + "noesis-reports"));
    return base.resolve("run-" + runId);
  }

  private Path surefireReportsDirectory(Path workspace) {
    return workspace.resolve("target").resolve("surefire-reports");
  }

  private String artifactType(Path path) {
    String name = path.getFileName().toString().toLowerCase(Locale.ROOT);
    if (name.endsWith(".xml")) return "xml";
    if (name.endsWith(".html") || name.endsWith(".htm")) return "html";
    if (name.endsWith(".pdf")) return "pdf";
    if (name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg")) return "screenshot";
    if (name.endsWith(".log") || name.endsWith(".txt")) return "log";
    return "artifact";
  }

  private boolean displayArtifact(Map<String, Object> artifact, List<String> scriptNames) {
    String fileName = str(artifact.get("fileName")).toLowerCase(Locale.ROOT);
    if (fileName.equals("execution-output.html") || fileName.equals("execution-output.pdf")) return true;
    if (fileName.equals("index.html") || fileName.equals("emailable-report.html") || fileName.equals("testng-results.xml")) return false;
    if (fileName.startsWith("testng-") || fileName.startsWith("surefire")) return false;
    return fileName.endsWith(".html") || fileName.endsWith(".pdf");
  }

  private boolean isGeneratedOutputArtifact(String fileName) {
    String name = fileName.toLowerCase(Locale.ROOT);
    return name.equals("execution-output.html") || name.equals("execution-output.pdf");
  }

  private String mimeType(Path path) throws IOException {
    String detected = Files.probeContentType(path);
    if (detected != null) return detected;
    String name = path.getFileName().toString().toLowerCase(Locale.ROOT);
    if (name.endsWith(".pdf")) return "application/pdf";
    if (name.endsWith(".xml")) return "application/xml";
    if (name.endsWith(".html") || name.endsWith(".htm")) return "text/html";
    if (name.endsWith(".txt") || name.endsWith(".log")) return "text/plain";
    return "application/octet-stream";
  }

  private void createExecutionOutputArtifacts(int runId, String runName, String status, ResultSummary summary, String output) {
    try {
      Path dir = reportsDirectory(runId);
      Files.createDirectories(dir);
      Path html = dir.resolve("execution-output.html");
      String escapedOutput = htmlEscape(output == null ? "" : output);
      String htmlContent = """
          <!doctype html>
          <html>
          <head>
            <meta charset="utf-8">
            <title>Noesis Execution Output</title>
            <style>
              body{font-family:Arial,sans-serif;margin:24px;color:#111827;background:#f8fafc}
              .card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin-bottom:16px}
              h1{margin:0 0 6px;font-size:22px}
              .status{font-weight:700;text-transform:uppercase}
              .passed{color:#16a34a}.failed,.error{color:#dc2626}
              pre{white-space:pre-wrap;background:#0f172a;color:#e2e8f0;padding:16px;border-radius:8px;overflow:auto}
              .grid{display:grid;grid-template-columns:repeat(4,minmax(90px,1fr));gap:10px}
              .metric{background:#f8fafc;border:1px solid #e5e7eb;border-radius:6px;padding:10px}
              .metric strong{display:block;font-size:20px}
            </style>
          </head>
          <body>
            <section class="card">
              <h1>%s</h1>
              <div>Run #%d · <span class="status %s">%s</span></div>
              <div>Generated: %s</div>
            </section>
            <section class="card grid">
              <div class="metric"><span>Passed</span><strong>%d</strong></div>
              <div class="metric"><span>Failed</span><strong>%d</strong></div>
              <div class="metric"><span>Errors</span><strong>%d</strong></div>
              <div class="metric"><span>Skipped</span><strong>%d</strong></div>
            </section>
            <section class="card">
              <h2>Execution Output</h2>
              <pre>%s</pre>
            </section>
          </body>
          </html>
          """.formatted(htmlEscape(runName), runId, htmlEscape(status), htmlEscape(status), Instant.now(),
          summary.passed, summary.failed, summary.errors, summary.skipped, escapedOutput);
      Files.writeString(html, htmlContent, StandardCharsets.UTF_8);
      saveArtifact(runId, null, "html", html);

      Path pdf = dir.resolve("execution-output.pdf");
      writeSimplePdf(pdf, List.of(
          "Noesis Execution Output",
          "Run #" + runId + " - " + runName,
          "Status: " + status.toUpperCase(Locale.ROOT),
          "Summary: " + summary.passed + " passed, " + summary.failed + " failed, " + summary.errors + " errors, " + summary.skipped + " skipped",
          "Generated: " + Instant.now(),
          "",
          "Output:",
          trim((output == null ? "" : output).replace("\r", ""), 8000)));
      saveArtifact(runId, null, "pdf", pdf);
    } catch (Exception e) {
      try { logExecution(runId, "WARN", "Could not create execution output artifacts: " + e.getMessage()); } catch (Exception ignored) {}
    }
  }

  private void ensureOutputArtifactsForRun(int runId) {
    try {
      int existing = intValue(db.one("""
          SELECT COUNT(*)::int AS count
          FROM execution_artifacts
          WHERE run_id = ? AND artifact_type IN ('html', 'pdf') AND file_name IN ('execution-output.html', 'execution-output.pdf')
          """, runId).get("count"), 0);
      if (existing >= 2) return;
      Map<String, Object> run = db.one("SELECT run_name, status, passed_count, failed_count, error_count, skipped_count FROM execution_runs WHERE id = ?", runId);
      if (run == null) return;
      StringBuilder output = new StringBuilder();
      for (Map<String, Object> log : db.rows("SELECT log_level, message, timestamp FROM execution_logs WHERE run_id = ? ORDER BY timestamp ASC", runId)) {
        output.append("[").append(str(log.get("timestamp"))).append("] [").append(str(log.get("logLevel"))).append("] ").append(str(log.get("message"))).append(System.lineSeparator());
      }
      ResultSummary summary = new ResultSummary(
          intValue(run.get("passedCount"), 0),
          intValue(run.get("failedCount"), 0),
          intValue(run.get("errorCount"), 0),
          intValue(run.get("skippedCount"), 0));
      createExecutionOutputArtifacts(runId, str(run.get("runName")), str(run.get("status")), summary, output.toString());
    } catch (Exception ignored) {}
  }

  private void writeSimplePdf(Path path, List<String> sections) throws IOException {
    String text = String.join("\n", sections);
    List<String> lines = new ArrayList<>();
    for (String raw : text.split("\n")) {
      String line = raw.length() > 92 ? raw.substring(0, 92) : raw;
      lines.add(line);
      if (lines.size() >= 58) break;
    }
    StringBuilder stream = new StringBuilder("BT\n/F1 9 Tf\n50 790 Td\n14 TL\n");
    for (String line : lines) {
      stream.append("(").append(pdfEscape(line)).append(") Tj\nT*\n");
    }
    stream.append("ET\n");
    byte[] streamBytes = stream.toString().getBytes(StandardCharsets.UTF_8);
    List<String> objects = List.of(
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
        "<< /Length " + streamBytes.length + " >>\nstream\n" + stream + "endstream");
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    out.write("%PDF-1.4\n".getBytes(StandardCharsets.US_ASCII));
    List<Integer> offsets = new ArrayList<>();
    for (int i = 0; i < objects.size(); i++) {
      offsets.add(out.size());
      out.write((i + 1 + " 0 obj\n").getBytes(StandardCharsets.US_ASCII));
      out.write(objects.get(i).getBytes(StandardCharsets.UTF_8));
      out.write("\nendobj\n".getBytes(StandardCharsets.US_ASCII));
    }
    int xref = out.size();
    out.write(("xref\n0 " + (objects.size() + 1) + "\n0000000000 65535 f \n").getBytes(StandardCharsets.US_ASCII));
    for (Integer offset : offsets) out.write(String.format(Locale.ROOT, "%010d 00000 n \n", offset).getBytes(StandardCharsets.US_ASCII));
    out.write(("trailer\n<< /Size " + (objects.size() + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n").getBytes(StandardCharsets.US_ASCII));
    Files.write(path, out.toByteArray());
  }

  private String htmlEscape(String value) {
    return (value == null ? "" : value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
  }

  private String pdfEscape(String value) {
    return (value == null ? "" : value).replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)").replaceAll("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]", " ");
  }

  private void sendMail(List<String> recipients, String subject, String text, List<Map<String, Object>> artifacts) throws MessagingException {
    Properties props = new Properties();
    props.put("mail.smtp.auth", "true");
    props.put("mail.smtp.host", env.value("SMTP_HOST", ""));
    props.put("mail.smtp.port", env.value("SMTP_PORT", "587"));
    props.put("mail.smtp.starttls.enable", String.valueOf(!Boolean.parseBoolean(env.value("SMTP_SECURE", "false"))));
    props.put("mail.smtp.ssl.enable", env.value("SMTP_SECURE", "false"));
    props.put("mail.smtp.connectiontimeout", "15000");
    props.put("mail.smtp.timeout", "30000");

    Session session = Session.getInstance(props, new Authenticator() {
      @Override protected PasswordAuthentication getPasswordAuthentication() {
        return new PasswordAuthentication(env.value("SMTP_USER", ""), env.value("SMTP_PASSWORD", ""));
      }
    });
    MimeMessage message = new MimeMessage(session);
    message.setFrom(parseFrom(env.value("MAIL_FROM", env.value("SMTP_USER", ""))));
    for (String recipient : recipients) message.addRecipient(Message.RecipientType.TO, new InternetAddress(recipient));
    message.setSubject(subject, StandardCharsets.UTF_8.name());

    Multipart multipart = new MimeMultipart();
    MimeBodyPart body = new MimeBodyPart();
    body.setText(text == null || text.isBlank() ? "Please find the selected execution artifacts attached." : text, StandardCharsets.UTF_8.name());
    multipart.addBodyPart(body);

    for (Map<String, Object> artifact : artifacts) {
      Path path = Path.of(str(artifact.get("storedPath")));
      if (!Files.exists(path)) throw new MessagingException("Artifact file not found on disk: " + artifact.get("fileName"));
      MimeBodyPart attachment = new MimeBodyPart();
      attachment.setDataHandler(new DataHandler(new FileDataSource(path.toFile())));
      attachment.setFileName(str(artifact.get("fileName")));
      multipart.addBodyPart(attachment);
    }
    message.setContent(multipart);
    Transport.send(message);
  }

  private InternetAddress parseFrom(String value) throws MessagingException {
    String clean = value == null ? "" : value.trim().replace("\"", "");
    Matcher m = Pattern.compile("(.+)<([^>]+)>").matcher(clean);
    if (m.matches()) {
      InternetAddress address = new InternetAddress(m.group(2).trim());
      try { address.setPersonal(m.group(1).trim(), StandardCharsets.UTF_8.name()); }
      catch (Exception e) { throw new MessagingException("Invalid MAIL_FROM value.", e); }
      return address;
    }
    return new InternetAddress(clean);
  }

  private boolean mailConfigured() {
    return Boolean.parseBoolean(env.value("MAIL_ENABLED", "false"))
        && !env.value("SMTP_HOST", "").isBlank()
        && !env.value("SMTP_USER", "").isBlank()
        && !env.value("SMTP_PASSWORD", "").isBlank()
        && !env.value("MAIL_FROM", env.value("SMTP_USER", "")).isBlank();
  }

  private void sendExecutionCompletionMail(int runId, String runName, String status, ResultSummary summary, String errorMessage) {
    try {
      if (!mailConfigured()) {
        logExecution(runId, "INFO", "Execution email notification skipped because mail is disabled or SMTP is not configured.");
        return;
      }
      Map<String, Object> run = db.one("""
          SELECT er.*, u.full_name AS triggered_by_name
          FROM execution_runs er
          LEFT JOIN users u ON u.id = er.triggered_by
          WHERE er.id = ?
          """, runId);
      if (run == null) return;
      int triggeredBy = intValue(run.get("triggeredBy"), 0);
      List<String> recipients = db.rows("""
          SELECT DISTINCT email
          FROM users
          WHERE is_active = TRUE
            AND email IS NOT NULL
            AND email <> ''
            AND (role IN ('admin', 'tester') OR id = ?)
          """, triggeredBy).stream()
          .map(row -> normalizeEmail(str(row.get("email"))))
          .filter(this::validEmail)
          .distinct()
          .toList();
      if (recipients.isEmpty()) {
        logExecution(runId, "WARN", "Execution email notification skipped: no admin/tester recipient emails found.");
        return;
      }
      String finalStatus = status == null ? "failed" : status;
      String subject = "[Noesis] Script execution " + ("passed".equals(finalStatus) ? "PASSED" : "FAILED") + ": " + runName;
      String runUrl = env.value("APP_BASE_URL", "").isBlank() ? "" : env.value("APP_BASE_URL", "").replaceAll("/+$", "") + "/run/" + runId;
      String text = String.join(System.lineSeparator(),
          "passed".equals(finalStatus) ? "The script execution passed successfully." : "The script execution failed or ended with errors.",
          "",
          "Run: " + runName + " (#" + runId + ")",
          "Status: " + finalStatus.toUpperCase(Locale.ROOT),
          "Environment: " + str(run.getOrDefault("environment", "local")),
          "Triggered by: " + (str(run.get("triggeredByName")).isBlank() ? "User " + triggeredBy : str(run.get("triggeredByName"))),
          "Started: " + str(run.get("startedAt")),
          "Completed: " + str(run.get("completedAt")),
          "Duration: " + formatDuration(run.get("durationMs")),
          "",
          "Summary: " + summary.passed + " passed, " + summary.failed + " failed, " + summary.errors + " errors, " + summary.skipped + " skipped out of " + intValue(run.get("totalScripts"), summary.total()) + " script(s).",
          errorMessage == null || errorMessage.isBlank() ? "" : "Error: " + errorMessage,
          runUrl.isBlank() ? "" : "View run details: " + runUrl);
      sendMail(recipients, subject, text, List.of());
      logExecution(runId, "INFO", "Execution email notification sent to " + recipients.size() + " recipient(s).");
    } catch (Exception e) {
      try { logExecution(runId, "WARN", "Execution email notification failed: " + e.getMessage()); } catch (Exception ignored) {}
    }
  }

  @SuppressWarnings("unchecked")
  private Map<String, Object> enrichRunMetadata(Map<String, Object> run) {
    Map<String, Object> metadata = new LinkedHashMap<>();
    Object raw = run.get("runMetadata");
    if (raw instanceof Map<?, ?> map) {
      for (Map.Entry<?, ?> entry : map.entrySet()) metadata.put(str(entry.getKey()), entry.getValue());
    }
    int runId = intValue(run.get("id"), 0);
    putDefault(metadata, "executionSource", env.value("ST_AUTOMATION_SOURCE", "git"));
    putDefault(metadata, "gitRepoUrl", gitRepositoryUrl());
    putDefault(metadata, "gitRepoName", gitRepositoryName());
    putDefault(metadata, "gitBranch", env.value("ST_AUTOMATION_GIT_BRANCH", "main"));
    String currentAppUrl = str(metadata.get("appUrl"));
    String resolvedAppUrl = firstNonBlank(resolveExecutionAppUrl(runId, run, metadata), env.value("ST_AUTOMATION_APP_URL", ""));
    if (!currentAppUrl.isBlank() && !isApplicationUrl(currentAppUrl) && !resolvedAppUrl.isBlank()) {
      metadata.put("appUrl", resolvedAppUrl);
    } else if (isFrontendOrLocalNoesisUrl(currentAppUrl) && !resolvedAppUrl.isBlank()) {
      metadata.put("appUrl", resolvedAppUrl);
    } else if (isFrontendOrLocalNoesisUrl(currentAppUrl)) {
      metadata.remove("appUrl");
    } else {
      putDefault(metadata, "appUrl", resolvedAppUrl);
    }
    putDefault(metadata, "workspacePath", env.value("ST_AUTOMATION_GIT_CACHE_PATH", env.value("ST_AUTOMATION_PATH", "")));
    putDefault(metadata, "suiteFileName", "noesis-testng-run-" + runId + ".xml");
    if (str(metadata.get("suiteFilePath")).isBlank()) {
      metadata.put("suiteFilePath", Path.of(str(metadata.get("workspacePath")), str(metadata.get("suiteFileName"))).toString());
    }
    String workspacePath = str(metadata.get("workspacePath"));
    if (!workspacePath.isBlank()) {
      metadata.put("reportsDirectory", surefireReportsDirectory(Path.of(workspacePath)).toString());
    } else {
      putDefault(metadata, "reportsDirectory", "");
    }
    putDefault(metadata, "mavenCommand", "mvn test -Dsurefire.suiteXmlFiles=" + str(metadata.get("suiteFilePath")));
    putDefault(metadata, "environment", str(run.get("environment")));
    putDefault(metadata, "startedAt", str(run.get("startedAt")));
    putDefault(metadata, "completedAt", str(run.get("completedAt")));
    putDefault(metadata, "finalStatus", str(run.get("status")));
    try {
      int artifactCount = intValue(db.one("SELECT COUNT(*)::int AS count FROM execution_artifacts WHERE run_id = ? AND artifact_type IN ('html','pdf')", runId).get("count"), 0);
      if (artifactCount > 0) putDefault(metadata, "artifactCount", artifactCount);
    } catch (Exception ignored) {}
    return metadata;
  }

  private String resolveExecutionAppUrl(int runId, Map<String, Object> run, Map<String, Object> metadata) {
    String metadataAppUrl = str(metadata.get("appUrl"));
    String configured = firstNonBlank(env.value("ST_AUTOMATION_APP_URL", ""), isFrontendOrLocalNoesisUrl(metadataAppUrl) ? "" : metadataAppUrl);
    if (isApplicationUrl(configured)) return configured;
    List<String> candidates = new ArrayList<>();
    try {
      for (Map<String, Object> result : db.rows("SELECT log_output, error_message FROM execution_results WHERE run_id = ?", runId)) {
        candidates.add(str(result.get("logOutput")));
        candidates.add(str(result.get("errorMessage")));
      }
      for (Map<String, Object> log : db.rows("SELECT message, detailed_description FROM execution_logs WHERE run_id = ? ORDER BY id DESC LIMIT 500", runId)) {
        candidates.add(str(log.get("message")));
        candidates.add(str(log.get("detailedDescription")));
      }
    } catch (Exception ignored) {}
    candidates.add(str(run.get("configXml")));
    String workspacePath = firstNonBlank(str(metadata.get("workspacePath")), env.value("ST_AUTOMATION_GIT_CACHE_PATH", env.value("ST_AUTOMATION_PATH", "")));
    if (!workspacePath.isBlank()) candidates.add(resolveExecutionAppUrlFromWorkspace(Path.of(workspacePath), runId));
    return candidates.stream().map(this::extractPreferredUrl).filter(url -> !url.isBlank()).findFirst().orElse("");
  }

  private String resolveExecutionAppUrlFromWorkspace(Path workspace, int runId) {
    if (!Files.isDirectory(workspace)) return "";
    List<Path> roots = new ArrayList<>();
    Path resources = workspace.resolve("src").resolve("test").resolve("resources");
    if (Files.isDirectory(resources)) roots.add(resources);
    Path mainResources = workspace.resolve("src").resolve("main").resolve("resources");
    if (Files.isDirectory(mainResources)) roots.add(mainResources);
    roots.add(workspace);
    for (Path root : roots) {
      try (var stream = Files.walk(root, 5)) {
        List<Path> files = stream.filter(Files::isRegularFile)
            .filter(path -> {
              String name = path.getFileName().toString().toLowerCase(Locale.ROOT);
              return name.endsWith(".java") || name.endsWith(".properties") || name.endsWith(".json") || name.endsWith(".xml");
            })
            .limit(250)
            .toList();
        for (Path file : files) {
          try {
            String found = extractPreferredUrl(Files.readString(file));
            if (!found.isBlank()) return found;
          } catch (Exception ignored) {}
        }
      } catch (Exception ignored) {}
    }
    return "";
  }

  private String extractPreferredUrl(String text) {
    if (text == null || text.isBlank()) return "";
    Matcher matcher = Pattern.compile("https?://[^\\s\"'<>),;\\]}]+", Pattern.CASE_INSENSITIVE).matcher(text);
    List<String> urls = new ArrayList<>();
    while (matcher.find()) urls.add(matcher.group());
    if (urls.isEmpty()) return "";
    for (String url : urls) {
      String lower = url.toLowerCase(Locale.ROOT);
      if (lower.contains("drogevate") || lower.contains("noesis") || lower.contains("sandbox") || lower.contains("staging")) return url;
    }
    for (String url : urls) {
      String lower = url.toLowerCase(Locale.ROOT);
      if (isApplicationUrl(url)) return url;
    }
    return "";
  }

  private boolean isApplicationUrl(String value) {
    if (!isHttpUrl(value)) return false;
    String lower = value.toLowerCase(Locale.ROOT);
    return !lower.contains("github.com")
        && !lower.contains("apache.org")
        && !lower.contains("maven")
        && !lower.contains("mvnrepository.com")
        && !lower.contains("w3.org")
        && !lower.contains("schema")
        && !lower.contains("testng.org")
        && !lower.endsWith(".dtd")
        && !lower.endsWith(".xsd");
  }

  private boolean isHttpUrl(String value) {
    return value != null && Pattern.compile("^https?://", Pattern.CASE_INSENSITIVE).matcher(value.trim()).find();
  }

  private boolean isFrontendOrLocalNoesisUrl(String value) {
    String url = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
    if (url.isBlank()) return true;
    String frontend = env.value("APP_BASE_URL", "").trim().toLowerCase(Locale.ROOT);
    return url.equals(frontend) || url.contains("localhost:4200") || url.contains("127.0.0.1:4200");
  }

  private String gitRepositoryUrl() {
    String configured = env.value("ST_AUTOMATION_GIT_REPO_URL", "");
    if (!configured.isBlank()) return configured;
    Path config = automationWorkspace().resolve(".git").resolve("config");
    if (!Files.isRegularFile(config)) return "";
    try {
      String content = Files.readString(config);
      Matcher m = Pattern.compile("(?m)^\\s*url\\s*=\\s*(.+?)\\s*$").matcher(content);
      return m.find() ? m.group(1).trim() : "";
    } catch (Exception ignored) {
      return "";
    }
  }

  private String gitRepositoryName() {
    String url = gitRepositoryUrl();
    if (!url.isBlank()) {
      String cleaned = url.replace('\\', '/');
      cleaned = cleaned.substring(cleaned.lastIndexOf('/') + 1);
      cleaned = cleaned.replaceFirst("(?i)\\.git$", "");
      if (!cleaned.isBlank()) return cleaned;
    }
    Path workspace = automationWorkspace();
    Path fileName = workspace.getFileName();
    return fileName == null ? "" : fileName.toString();
  }

  private void putDefault(Map<String, Object> map, String key, Object value) {
    if (str(map.get(key)).isBlank() && value != null && !str(value).isBlank()) map.put(key, value);
  }

  private String firstNonBlank(String... values) {
    for (String value : values) if (value != null && !value.isBlank()) return value;
    return "";
  }

  private Object nextRunAt(String cron, boolean oneTime) {
    try {
      String[] parts = cron == null ? new String[0] : cron.trim().split("\\s+");
      if (parts.length < 5) return null;
      int minute = Integer.parseInt(parts[0]);
      int hour = Integer.parseInt(parts[1]);
      if (oneTime) {
        int day = Integer.parseInt(parts[2]);
        int month = Integer.parseInt(parts[3]);
        int year = java.time.LocalDate.now().getYear();
        java.time.LocalDateTime dt = java.time.LocalDateTime.of(year, month, day, hour, minute);
        if (dt.isBefore(java.time.LocalDateTime.now())) dt = dt.plusYears(1);
        return Timestamp.valueOf(dt);
      }
      java.time.LocalDateTime now = java.time.LocalDateTime.now();
      java.time.LocalDateTime candidate = now.withHour(hour).withMinute(minute).withSecond(0).withNano(0);
      if (!parts[4].equals("*")) {
        int cronDow = Integer.parseInt(parts[4].split("-")[0]);
        int javaDow = cronDow == 0 ? 7 : cronDow;
        while (candidate.getDayOfWeek().getValue() != javaDow || !candidate.isAfter(now)) candidate = candidate.plusDays(1);
        return Timestamp.valueOf(candidate);
      }
      if (!candidate.isAfter(now)) candidate = candidate.plusDays(1);
      return Timestamp.valueOf(candidate);
    } catch (Exception ignored) {
      return null;
    }
  }

  private String normalizeEmail(String email) {
    String value = email == null ? "" : email.trim();
    Matcher named = Pattern.compile("<([^>]+)>").matcher(value);
    return named.find() ? named.group(1).trim() : value;
  }

  private boolean validEmail(String email) {
    return email != null && Pattern.matches("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", email);
  }

  private String formatDuration(Object value) {
    long ms = intValue(value, 0);
    if (ms <= 0) return "N/A";
    long seconds = ms / 1000;
    long minutes = seconds / 60;
    long hours = minutes / 60;
    if (hours > 0) return hours + "h " + (minutes % 60) + "m";
    if (minutes > 0) return minutes + "m " + (seconds % 60) + "s";
    return seconds + "s";
  }

  private ResultSummary parseTestResults(String output) {
    Matcher m = Pattern.compile("Tests run:\\s*(\\d+),\\s*Failures:\\s*(\\d+),\\s*Errors:\\s*(\\d+),\\s*Skipped:\\s*(\\d+)", Pattern.CASE_INSENSITIVE).matcher(output == null ? "" : output);
    if (!m.find()) return new ResultSummary(0, 0, 0, 0);
    int total = Integer.parseInt(m.group(1));
    int failed = Integer.parseInt(m.group(2));
    int errors = Integer.parseInt(m.group(3));
    int skipped = Integer.parseInt(m.group(4));
    return new ResultSummary(Math.max(0, total - failed - errors - skipped), failed, errors, skipped);
  }

  private ResultSummary parseTestResultsFromXml(String content) {
    String text = content == null ? "" : content;
    Matcher testNg = Pattern.compile("<testng-results\\b[^>]*>", Pattern.CASE_INSENSITIVE).matcher(text);
    if (testNg.find()) {
      String tag = testNg.group();
      Integer total = attr(tag, "total");
      Integer passed = attr(tag, "passed");
      Integer failed = attr(tag, "failed");
      Integer skipped = attr(tag, "skipped");
      if (total != null && passed != null && failed != null && skipped != null) {
        return new ResultSummary(passed, failed, Math.max(0, total - passed - failed - skipped), skipped);
      }
    }
    Matcher suite = Pattern.compile("<testsuite\\b[^>]*>", Pattern.CASE_INSENSITIVE).matcher(text);
    if (suite.find()) {
      String tag = suite.group();
      Integer total = attr(tag, "tests");
      Integer failed = attr(tag, "failures");
      Integer errors = attr(tag, "errors");
      Integer skipped = attr(tag, "skipped");
      if (total != null) {
        failed = failed == null ? 0 : failed;
        errors = errors == null ? 0 : errors;
        skipped = skipped == null ? 0 : skipped;
        return new ResultSummary(Math.max(0, total - failed - errors - skipped), failed, errors, skipped);
      }
    }
    return null;
  }

  private Integer attr(String source, String name) {
    Matcher m = Pattern.compile("\\b" + Pattern.quote(name) + "=\"(\\d+)\"", Pattern.CASE_INSENSITIVE).matcher(source);
    return m.find() ? Integer.parseInt(m.group(1)) : null;
  }

  private ResultSummary parseTestResultsFromReports(Path workspace) {
    Path surefire = workspace.resolve("target").resolve("surefire-reports");
    List<Path> candidates = new ArrayList<>(List.of(
        surefire.resolve("testng-results.xml"),
        surefire.resolve("TEST-TestSuite.xml"),
        surefire.resolve("TestSuite.txt")));
    if (Files.isDirectory(surefire)) {
      try (var stream = Files.walk(surefire, 2)) {
        stream.filter(Files::isRegularFile)
            .filter(path -> {
              String n = path.getFileName().toString().toLowerCase(Locale.ROOT);
              return n.endsWith(".xml") || n.endsWith(".txt") || n.endsWith(".log");
            })
            .forEach(candidates::add);
      } catch (Exception ignored) {}
    }
    for (Path candidate : candidates) {
      try {
        if (!Files.isRegularFile(candidate)) continue;
        String content = Files.readString(candidate);
        ResultSummary fromXml = parseTestResultsFromXml(content);
        if (fromXml != null && fromXml.total() > 0) return fromXml;
        ResultSummary fromText = parseTestResults(content);
        if (fromText.total() > 0) return fromText;
      } catch (Exception ignored) {}
    }
    return null;
  }

  private ResultSummary finalSummary(int exit, String output, Path workspace, int scriptCount) {
    ResultSummary summary = parseTestResultsFromReports(workspace);
    if (summary == null || summary.total() == 0) summary = parseTestResults(output);
    boolean browserFailure = Pattern.compile("NoSuchSessionException|invalid session id|browser has closed the connection|disconnected: not connected to DevTools|chrome not reachable", Pattern.CASE_INSENSITIVE)
        .matcher(output == null ? "" : output).find();
    if ((exit != 0 || browserFailure) && summary.failed + summary.errors == 0) {
      return new ResultSummary(summary.passed, Math.max(1, scriptCount - summary.passed - summary.skipped), browserFailure ? 1 : summary.errors, summary.skipped);
    }
    return summary;
  }

  private void ensureSchema() {
    try { db.update("ALTER TABLE test_suites ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT NULL"); } catch (Exception ignored) {}
    ensureAssignments();
    ensureDependencies();
    ensureUserLockout();
    try { db.update("""
        CREATE TABLE IF NOT EXISTS notifications (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          severity VARCHAR(20) NOT NULL,
          summary VARCHAR(255) NOT NULL,
          detail TEXT NOT NULL,
          icon VARCHAR(50) NOT NULL,
          source VARCHAR(100) DEFAULT 'System',
          category VARCHAR(100) DEFAULT 'General',
          action_url VARCHAR(500),
          is_read BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """); } catch (Exception ignored) {}
    try { db.update("""
        CREATE TABLE IF NOT EXISTS app_logs (
          id SERIAL PRIMARY KEY,
          timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          level VARCHAR(20) DEFAULT 'INFO',
          severity VARCHAR(20) DEFAULT 'INFO',
          module VARCHAR(100) DEFAULT 'application',
          action VARCHAR(100),
          status VARCHAR(50),
          message TEXT NOT NULL,
          user_id INT NULL,
          username VARCHAR(100),
          request_id VARCHAR(100),
          http_method VARCHAR(10),
          http_path TEXT,
          http_status INT,
          metadata JSONB DEFAULT NULL
        )
        """); } catch (Exception ignored) {}
    ensureConfigurationChanges();
  }

  private void ensureConfigurationChanges() {
    try { db.update("""
        CREATE TABLE IF NOT EXISTS script_configuration_changes (
          id SERIAL PRIMARY KEY,
          script_id INT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          file_name TEXT NOT NULL,
          file_type VARCHAR(20) NOT NULL,
          changed_by TEXT DEFAULT 'System',
          changed_by_user_id INT NULL REFERENCES users(id) ON DELETE SET NULL,
          changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          change_summary JSONB DEFAULT '{}'::jsonb,
          previous_content TEXT NOT NULL,
          updated_content TEXT NOT NULL
        )
        """); } catch (Exception ignored) {}
    try { db.update("""
        CREATE INDEX IF NOT EXISTS script_configuration_changes_script_changed_idx
        ON script_configuration_changes (script_id, changed_at DESC, id DESC)
        """); } catch (Exception ignored) {}
  }

  private void ensureAssignments() {
    try { db.update("""
        CREATE TABLE IF NOT EXISTS script_assignments (
          id SERIAL PRIMARY KEY,
          user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          script_id INT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
          assigned_by INT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
          assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (user_id, script_id)
        )
        """); } catch (Exception ignored) {}
  }

  private void ensureDependencies() {
    try { db.update("""
        CREATE TABLE IF NOT EXISTS script_dependencies (
          script_id INT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
          dependency_script_id INT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (script_id, dependency_script_id)
        )
        """); } catch (Exception ignored) {}
    try { db.update("""
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'script_dependencies' AND column_name = 'depends_on_script_id'
          ) AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'script_dependencies' AND column_name = 'dependency_script_id'
          ) THEN
            ALTER TABLE script_dependencies RENAME COLUMN depends_on_script_id TO dependency_script_id;
          END IF;
        END $$;
        """); } catch (Exception ignored) {}
    try { db.update("""
        CREATE UNIQUE INDEX IF NOT EXISTS script_dependencies_pair_idx
        ON script_dependencies (script_id, dependency_script_id)
        """); } catch (Exception ignored) {}
  }

  private void ensureUserLockout() {
    try { db.update("ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0"); } catch (Exception ignored) {}
    try { db.update("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT FALSE"); } catch (Exception ignored) {}
    try { db.update("ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP DEFAULT NULL"); } catch (Exception ignored) {}
    try { db.update("ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_by INT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL"); } catch (Exception ignored) {}
    try { db.update("ALTER TABLE users ADD COLUMN IF NOT EXISTS unlocked_at TIMESTAMP DEFAULT NULL"); } catch (Exception ignored) {}
    try { db.update("ALTER TABLE users ADD COLUMN IF NOT EXISTS unlocked_by INT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL"); } catch (Exception ignored) {}
  }

  private Auth auth(HttpExchange ex) throws IOException, SQLException {
    String header = ex.getRequestHeaders().getFirst("Authorization");
    if (header == null || !header.startsWith("Bearer ")) {
      send(ex, 401, error("Access token required."));
      return null;
    }
    try {
      Auth decoded = jwt.verify(header.substring(7));
      Map<String, Object> user = db.one("SELECT id, username, role, is_active, COALESCE(is_locked, FALSE) AS is_locked FROM users WHERE id = ?", decoded.userId);
      if (user == null || Boolean.FALSE.equals(user.get("isActive"))) {
        send(ex, 401, error("Invalid token."));
        return null;
      }
      if (Boolean.TRUE.equals(user.get("isLocked"))) {
        send(ex, 423, error("This account is locked. Please contact an administrator to unlock it."));
        return null;
      }
      return new Auth(intValue(user.get("id"), 0), str(user.get("role")), str(user.get("username")));
    } catch (Exception e) {
      send(ex, 401, error("Invalid token."));
      return null;
    }
  }

  private Map<String, Object> body(HttpExchange ex) throws IOException {
    byte[] bytes = ex.getRequestBody().readAllBytes();
    if (bytes.length == 0) return new LinkedHashMap<>();
    return JSON.readValue(bytes, MAP);
  }

  private MultipartFile multipartFile(HttpExchange ex) throws IOException {
    String contentType = ex.getRequestHeaders().getFirst("Content-Type");
    if (contentType == null || !contentType.contains("boundary=")) return null;
    String boundary = "--" + contentType.substring(contentType.indexOf("boundary=") + 9).trim();
    byte[] raw = ex.getRequestBody().readAllBytes();
    String text = new String(raw, StandardCharsets.ISO_8859_1);
    int filenameIdx = text.indexOf("filename=\"");
    if (filenameIdx < 0) return null;
    int filenameEnd = text.indexOf('"', filenameIdx + 10);
    String fileName = Path.of(text.substring(filenameIdx + 10, filenameEnd)).getFileName().toString();
    int contentStart = text.indexOf("\r\n\r\n", filenameEnd);
    if (contentStart < 0) return null;
    contentStart += 4;
    int contentEnd = text.indexOf("\r\n" + boundary, contentStart);
    if (contentEnd < 0) contentEnd = raw.length;
    byte[] bytes = text.substring(contentStart, contentEnd).getBytes(StandardCharsets.ISO_8859_1);
    return new MultipartFile(fileName, bytes);
  }

  private void send(HttpExchange ex, int status, Object value) throws IOException {
    if (value == null) {
      ex.sendResponseHeaders(status, -1);
      ex.close();
      return;
    }
    byte[] bytes = JSON.writeValueAsBytes(value);
    ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    sendBytes(ex, status, bytes);
  }

  private void sendBytes(HttpExchange ex, int status, byte[] bytes) throws IOException {
    ex.sendResponseHeaders(status, bytes.length);
    try (OutputStream os = ex.getResponseBody()) {
      os.write(bytes);
    }
  }

  private void addCors(HttpExchange ex) {
    Headers h = ex.getResponseHeaders();
    h.set("Access-Control-Allow-Origin", origin(ex));
    h.set("Access-Control-Allow-Credentials", "true");
    h.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  }

  private String origin(HttpExchange ex) {
    String requestOrigin = ex.getRequestHeaders().getFirst("Origin");
    if (requestOrigin == null || requestOrigin.isBlank()) return env.value("CORS_ORIGIN", "http://localhost:4200").split(",")[0].trim();
    Set<String> allowed = Set.of(env.value("CORS_ORIGIN", "http://localhost:4200").split(","));
    return allowed.stream().map(String::trim).anyMatch(requestOrigin::equals) ? requestOrigin : allowed.iterator().next().trim();
  }

  private Map<String, String> query(URI uri) {
    Map<String, String> out = new HashMap<>();
    String raw = uri.getRawQuery();
    if (raw == null || raw.isBlank()) return out;
    for (String pair : raw.split("&")) {
      int split = pair.indexOf('=');
      String key = decode(split >= 0 ? pair.substring(0, split) : pair);
      String val = decode(split >= 0 ? pair.substring(split + 1) : "");
      out.put(key, val);
    }
    return out;
  }

  private String decode(String s) {
    return URLDecoder.decode(s, StandardCharsets.UTF_8);
  }

  private boolean match(String path, String regex) {
    return Pattern.matches(regex, path);
  }

  private int id(String path) {
    Matcher m = Pattern.compile("(\\d+)").matcher(path);
    return m.find() ? Integer.parseInt(m.group(1)) : 0;
  }

  private int lastId(String path) {
    Matcher m = Pattern.compile("(\\d+)").matcher(path);
    int id = 0;
    while (m.find()) id = Integer.parseInt(m.group(1));
    return id;
  }

  private void admin(Auth auth) { if (!"admin".equals(auth.role)) throw new ApiException(403, "Forbidden: Admin access required."); }
  private void edit(Auth auth) { if (!"admin".equals(auth.role) && !"tester".equals(auth.role)) throw new ApiException(403, "Forbidden: insufficient permissions."); }
  private Map<String, Object> message(String msg) { return Map.of("message", msg); }
  private Map<String, Object> error(String msg) { return Map.of("error", msg); }
  private String placeholders(int count) { return String.join(",", java.util.Collections.nCopies(count, "?")); }
  private String json(Object v) throws IOException { return v == null ? null : JSON.writeValueAsString(v); }
  private String str(Object v) { return v == null ? "" : String.valueOf(v); }
  private Object blankNull(Object v) { return v == null || str(v).isBlank() ? null : v; }
  private int intValue(Object v, int fallback) { try { return v instanceof Number n ? n.intValue() : Integer.parseInt(str(v)); } catch (Exception e) { return fallback; } }
  private String trim(String value, int max) { return value == null || value.length() <= max ? value : value.substring(0, max); }
  private String severity(String line) {
    String l = line.toLowerCase(Locale.ROOT);
    if (l.contains("warning") || l.contains("[warning]") || l.contains(" warn")) return "WARN";
    if (l.matches(".*\\b(errors|failures):\\s*[1-9]\\d*.*") || l.contains("build failure") || l.contains("exception") || l.contains("[error]")) return "ERROR";
    return "INFO";
  }
  private List<Integer> intList(Object value) {
    List<Integer> out = new ArrayList<>();
    if (value instanceof Iterable<?> iterable) for (Object item : iterable) { int id = intValue(item, 0); if (id > 0 && !out.contains(id)) out.add(id); }
    return out;
  }
  private List<String> stringList(Object value) {
    List<String> out = new ArrayList<>();
    if (value instanceof Iterable<?> iterable) for (Object item : iterable) { String s = str(item).trim(); if (!s.isBlank() && !out.contains(s)) out.add(s); }
    return out;
  }
  private List<Object> prepend(Object first, List<?> values) {
    List<Object> out = new ArrayList<>();
    out.add(first);
    out.addAll(values);
    return out;
  }
  private List<Integer> dependencyIds(int id) {
    try { return db.rows("SELECT dependency_script_id FROM script_dependencies WHERE script_id = ? ORDER BY dependency_script_id", id).stream().map(r -> intValue(r.get("dependencyScriptId"), 0)).toList(); }
    catch (Exception ignored) { return List.of(); }
  }
  private boolean hasAssignedScripts(int userId, List<Integer> scriptIds) throws SQLException {
    List<Integer> unique = scriptIds.stream().filter(id -> id > 0).distinct().toList();
    if (unique.isEmpty()) return true;
    Number count = (Number) db.one("SELECT COUNT(DISTINCT script_id)::int AS count FROM script_assignments WHERE user_id = ? AND script_id IN (" + placeholders(unique.size()) + ")", prepend(userId, unique).toArray()).get("count");
    return count.intValue() == unique.size();
  }
  private void requireScriptAccess(Auth auth, int scriptId) throws SQLException {
    if (!"tester".equals(auth.role)) return;
    int count = intValue(db.one("SELECT COUNT(*)::int AS count FROM script_assignments WHERE user_id = ? AND script_id = ?", auth.userId, scriptId).get("count"), 0);
    if (count == 0) throw new ApiException(403, "Access denied: This script is not assigned to you.");
  }
  private List<Integer> resolveScriptExecutionPlan(List<Integer> requested) {
    LinkedHashSet<Integer> expanded = new LinkedHashSet<>();
    LinkedHashSet<Integer> visiting = new LinkedHashSet<>();
    for (Integer id : requested) resolveScriptDependencies(id, expanded, visiting);
    return new ArrayList<>(expanded);
  }
  private void resolveScriptDependencies(Integer id, LinkedHashSet<Integer> expanded, LinkedHashSet<Integer> visiting) {
    if (id == null || id <= 0 || expanded.contains(id) || visiting.contains(id)) return;
    visiting.add(id);
    for (Integer dep : dependencyIds(id)) resolveScriptDependencies(dep, expanded, visiting);
    visiting.remove(id);
    expanded.add(id);
  }
  private Map<String, Object> userDto(Map<String, Object> u) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("id", u.get("id")); out.put("username", u.get("username")); out.put("email", u.get("email")); out.put("fullName", u.get("fullName")); out.put("role", u.get("role")); out.put("avatarUrl", u.get("avatarUrl"));
    return out;
  }
  private Path resolveScriptPath(Object filePath) {
    String value = str(filePath);
    if (value.isBlank()) return automationWorkspace();
    Path p = Path.of(value);
    if (p.isAbsolute()) return p;
    Path workspace = automationWorkspace();
    List<Path> candidates = List.of(
        workspace.resolve(p),
        workspace.resolve("src").resolve("test").resolve("java").resolve(p),
        workspace.resolve("src").resolve("main").resolve("java").resolve(p),
        Path.of(env.value("ST_AUTOMATION_IMPORT_PATH", "scripts")).resolve(p));
    for (Path candidate : candidates) if (Files.exists(candidate)) return candidate;
    Path byName = findFileByName(workspace, p.getFileName().toString());
    return byName == null ? candidates.get(0) : byName;
  }

  private Path automationWorkspace() {
    if (env.value("ST_AUTOMATION_SOURCE", "git").equalsIgnoreCase("git")) {
      return Path.of(env.value("ST_AUTOMATION_GIT_CACHE_PATH", env.value("ST_AUTOMATION_PATH", "scripts")));
    }
    return Path.of(env.value("ST_AUTOMATION_PATH", "scripts"));
  }

  private Path resolveImportPath(Path workspace, String importName) {
    if (importName == null || importName.isBlank() || importName.endsWith(".*")) return null;
    Path relative = Path.of(importName.replace('.', File.separatorChar) + ".java");
    List<Path> candidates = List.of(
        workspace.resolve("src").resolve("test").resolve("java").resolve(relative),
        workspace.resolve("src").resolve("main").resolve("java").resolve(relative),
        workspace.resolve(relative));
    for (Path candidate : candidates) if (Files.exists(candidate)) return candidate;
    return findFileByName(workspace, relative.getFileName().toString());
  }

  private Path resolveResourceReference(Path scriptPath, Path workspace, String reference) {
    if (reference == null || reference.isBlank() || reference.contains("${")) return null;
    String cleaned = reference.replace("\\", File.separator).replace("/", File.separator);
    Path raw = Path.of(cleaned);
    List<Path> candidates = new ArrayList<>();
    if (raw.isAbsolute()) candidates.add(raw);
    if (scriptPath != null && scriptPath.getParent() != null) candidates.add(scriptPath.getParent().resolve(raw));
    candidates.add(workspace.resolve(raw));
    candidates.add(workspace.resolve("src").resolve("test").resolve("resources").resolve(raw));
    candidates.add(workspace.resolve("src").resolve("main").resolve("resources").resolve(raw));
    for (Path candidate : candidates) if (Files.exists(candidate)) return candidate;
    return raw.getFileName() == null ? null : findFileByName(workspace, raw.getFileName().toString());
  }

  private Path findFileByName(Path root, String fileName) {
    if (root == null || fileName == null || fileName.isBlank() || !Files.isDirectory(root)) return null;
    try (var stream = Files.walk(root, 8)) {
      return stream.filter(Files::isRegularFile)
          .filter(path -> path.getFileName().toString().equalsIgnoreCase(fileName))
          .findFirst()
          .orElse(null);
    } catch (Exception ignored) {
      return null;
    }
  }

  private List<String> javaImports(String source) {
    List<String> imports = new ArrayList<>();
    Matcher m = Pattern.compile("(?m)^\\s*import\\s+(?:static\\s+)?([a-zA-Z_][\\w.]*)(?:\\.\\*)?\\s*;").matcher(source == null ? "" : source);
    while (m.find()) imports.add(m.group(1));
    return imports;
  }

  private List<String> javaMethods(String source) {
    List<String> methods = new ArrayList<>();
    Matcher m = Pattern.compile("(?m)^\\s*(?:public|protected|private)?\\s*(?:static\\s+)?(?:final\\s+)?[\\w<>\\[\\], ?]+\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\([^;{}]*\\)\\s*(?:throws\\s+[\\w.,\\s]+)?\\{").matcher(source == null ? "" : source);
    while (m.find()) {
      String name = m.group(1);
      if (!Set.of("if", "for", "while", "switch", "catch").contains(name)) methods.add(name);
    }
    return methods;
  }
  private String inferPrimaryMethod(String source) {
    Matcher testMethod = Pattern.compile("(?s)@Test(?:\\s*\\([^)]*\\))?\\s*(?:public|protected|private)?\\s*(?:static\\s+)?(?:final\\s+)?[\\w<>\\[\\], ?]+\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\(").matcher(source == null ? "" : source);
    if (testMethod.find()) return testMethod.group(1);
    List<String> methods = javaMethods(source);
    return methods.isEmpty() ? "" : methods.get(0);
  }
  private String className(String source, String fileName) {
    String pkg = packageName(source);
    Matcher m = Pattern.compile("(?m)^\\s*(?:public\\s+)?(?:class|interface|enum|record)\\s+([A-Za-z_][A-Za-z0-9_]*)").matcher(source);
    String simple = m.find() ? m.group(1) : fileName.replaceFirst("(?i)\\.java$", "");
    return pkg == null ? simple : pkg + "." + simple;
  }
  private String packageName(String source) {
    Matcher m = Pattern.compile("(?m)^\\s*package\\s+([a-zA-Z_][\\w.]*)\\s*;").matcher(source);
    return m.find() ? m.group(1) : null;
  }
  private String buildTestNgXml(String runName, List<Map<String, Object>> scripts) {
    StringBuilder xml = new StringBuilder("<!DOCTYPE suite SYSTEM \"https://testng.org/testng-1.0.dtd\">\n<suite name=\"").append(escapeXml(runName)).append("\">\n  <test name=\"Noesis Test\">\n    <classes>\n");
    for (Map<String, Object> script : scripts) xml.append("      <class name=\"").append(escapeXml(str(script.get("className")))).append("\"/>\n");
    return xml.append("    </classes>\n  </test>\n</suite>\n").toString();
  }
  private String escapeXml(String s) { return s.replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;"); }

  record Auth(int userId, String role, String username) {}
  record MultipartFile(String fileName, byte[] bytes) {}
  record ResultSummary(int passed, int failed, int errors, int skipped) {
    int total() { return passed + failed + errors + skipped; }
  }

  static final class ApiException extends RuntimeException {
    final int status;
    ApiException(int status, String message) { super(message); this.status = status; }
  }

  static final class Env {
    String value(String key, String fallback) {
      String prop = System.getProperty(key);
      if (prop != null) return prop;
      String env = System.getenv(key);
      return env == null || env.isBlank() ? fallback : env;
    }
    int intValue(String key, int fallback) {
      try { return Integer.parseInt(value(key, String.valueOf(fallback))); } catch (Exception e) { return fallback; }
    }
    String jdbcUrl() { return "jdbc:postgresql://" + value("DB_HOST", "localhost") + ":" + value("DB_PORT", "5432") + "/" + value("DB_NAME", "noesis_testing"); }
    String dbUser() { return value("DB_USER", "postgres"); }
    String dbPassword() { return value("DB_PASSWORD", ""); }
    String jwtSecret() { return value("JWT_SECRET", "fallback-secret-change-me"); }
    String jwtExpiresIn() { return value("JWT_EXPIRES_IN", "24h"); }
    static void loadDotenv() {
      Path env = Files.exists(Path.of(".env")) ? Path.of(".env") : Path.of("backend", ".env");
      if (!Files.exists(env)) return;
      try {
        for (String line : Files.readAllLines(env)) {
          String t = line.trim();
          if (t.isEmpty() || t.startsWith("#") || !t.contains("=")) continue;
          int split = t.indexOf('=');
          String key = t.substring(0, split).trim();
          String val = t.substring(split + 1).trim();
          if ((val.startsWith("\"") && val.endsWith("\"")) || (val.startsWith("'") && val.endsWith("'"))) val = val.substring(1, val.length() - 1);
          if (!key.isBlank() && System.getProperty(key) == null && System.getenv(key) == null) System.setProperty(key, val);
        }
      } catch (IOException ignored) {}
    }
  }

  static final class Db {
    private final Env env;
    Db(Env env) { this.env = env; }
    Connection connection() throws SQLException { return DriverManager.getConnection(env.jdbcUrl(), env.dbUser(), env.dbPassword()); }
    Map<String, Object> one(String sql, Object... args) throws SQLException {
      List<Map<String, Object>> rows = rows(sql, args);
      return rows.isEmpty() ? null : rows.get(0);
    }
    List<Map<String, Object>> rows(String sql, Object... args) throws SQLException {
      try (Connection c = connection(); PreparedStatement ps = c.prepareStatement(sql)) {
        bind(ps, args);
        try (ResultSet rs = ps.executeQuery()) {
          List<Map<String, Object>> out = new ArrayList<>();
          while (rs.next()) out.add(row(rs));
          return out;
        }
      }
    }
    int update(String sql, Object... args) throws SQLException {
      try (Connection c = connection(); PreparedStatement ps = c.prepareStatement(sql)) {
        bind(ps, args);
        return ps.executeUpdate();
      }
    }
    void bind(PreparedStatement ps, Object[] args) throws SQLException {
      for (int i = 0; i < args.length; i++) ps.setObject(i + 1, args[i]);
    }
    Map<String, Object> row(ResultSet rs) throws SQLException {
      ResultSetMetaData meta = rs.getMetaData();
      Map<String, Object> out = new LinkedHashMap<>();
      for (int i = 1; i <= meta.getColumnCount(); i++) out.put(camel(meta.getColumnLabel(i)), normalize(rs.getObject(i)));
      return out;
    }
    Object normalize(Object v) throws SQLException {
      if (v instanceof Timestamp ts) return ts.toInstant().toString();
      if (v instanceof java.sql.Date d) return d.toLocalDate().toString();
      if (v instanceof PGobject pg && ("json".equals(pg.getType()) || "jsonb".equals(pg.getType()))) {
        try { return JSON.readValue(pg.getValue(), ANY); } catch (Exception ignored) { return pg.getValue(); }
      }
      if (v instanceof java.sql.Array a) return List.of((Object[]) a.getArray());
      return v;
    }
    String camel(String input) {
      StringBuilder out = new StringBuilder();
      boolean upper = false;
      for (char c : input.toLowerCase(Locale.ROOT).toCharArray()) {
        if (c == '_') upper = true;
        else if (upper) { out.append(Character.toUpperCase(c)); upper = false; }
        else out.append(c);
      }
      return out.toString();
    }
  }

  static final class Jwt {
    private final byte[] secret;
    private final long ttlSeconds;
    Jwt(String secret, String expiresIn) {
      this.secret = secret.getBytes(StandardCharsets.UTF_8);
      this.ttlSeconds = parseTtl(expiresIn);
    }
    String create(int userId, String role) {
      try {
        String header = b64(jsonStatic(Map.of("alg", "HS256", "typ", "JWT")).getBytes(StandardCharsets.UTF_8));
        long exp = Instant.now().getEpochSecond() + ttlSeconds;
        String payload = b64(jsonStatic(Map.of("userId", userId, "role", role, "exp", exp)).getBytes(StandardCharsets.UTF_8));
        return header + "." + payload + "." + sign(header + "." + payload);
      } catch (Exception e) {
        throw new RuntimeException(e);
      }
    }
    Auth verify(String token) throws Exception {
      String[] parts = token.split("\\.");
      if (parts.length != 3 || !MessageDigest.isEqual(parts[2].getBytes(StandardCharsets.UTF_8), sign(parts[0] + "." + parts[1]).getBytes(StandardCharsets.UTF_8))) throw new ApiException(401, "Invalid token.");
      Map<String, Object> payload = JSON.readValue(Base64.getUrlDecoder().decode(parts[1]), MAP);
      if (longValue(payload.get("exp")) < Instant.now().getEpochSecond()) throw new ApiException(401, "Invalid token.");
      return new Auth(((Number) payload.get("userId")).intValue(), String.valueOf(payload.get("role")), null);
    }
    String sign(String content) throws Exception {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(secret, "HmacSHA256"));
      return b64(mac.doFinal(content.getBytes(StandardCharsets.UTF_8)));
    }
    static String b64(byte[] bytes) { return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes); }
    static String jsonStatic(Object value) throws IOException { return JSON.writeValueAsString(value); }
    static long longValue(Object v) { return v instanceof Number n ? n.longValue() : Long.parseLong(String.valueOf(v)); }
    static long parseTtl(String value) {
      try {
        String t = value == null ? "24h" : value.trim().toLowerCase(Locale.ROOT);
        if (t.endsWith("d")) return Long.parseLong(t.substring(0, t.length() - 1)) * 86400;
        if (t.endsWith("h")) return Long.parseLong(t.substring(0, t.length() - 1)) * 3600;
        if (t.endsWith("m")) return Long.parseLong(t.substring(0, t.length() - 1)) * 60;
        if (t.endsWith("s")) return Long.parseLong(t.substring(0, t.length() - 1));
        return Long.parseLong(t);
      } catch (Exception ignored) { return 86400; }
    }
  }
}
