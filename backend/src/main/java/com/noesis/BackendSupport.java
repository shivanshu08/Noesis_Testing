package com.noesis;


import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
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
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.postgresql.util.PGobject;

class BackendSupport {
  protected static final ObjectMapper JSON = new ObjectMapper();
  protected static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {};
  protected static final TypeReference<Object> ANY = new TypeReference<>() {};

  protected final Env env;
  protected final Db db;
  protected final Jwt jwt;
  protected final Map<Integer, Process> activeProcesses = new ConcurrentHashMap<>();

  BackendSupport() {
    this.env = new Env();
    this.db = new Db(env);
    this.jwt = new Jwt(env.jwtSecret(), env.jwtExpiresIn());
  }

  protected void ensureSchema() {
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

  protected void ensureConfigurationChanges() {
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

  protected void ensureAssignments() {
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

  protected void ensureDependencies() {
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

  protected void ensureUserLockout() {
    try { db.update("ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0"); } catch (Exception ignored) {}
    try { db.update("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT FALSE"); } catch (Exception ignored) {}
    try { db.update("ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP DEFAULT NULL"); } catch (Exception ignored) {}
    try { db.update("ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_by INT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL"); } catch (Exception ignored) {}
    try { db.update("ALTER TABLE users ADD COLUMN IF NOT EXISTS unlocked_at TIMESTAMP DEFAULT NULL"); } catch (Exception ignored) {}
    try { db.update("ALTER TABLE users ADD COLUMN IF NOT EXISTS unlocked_by INT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL"); } catch (Exception ignored) {}
  }

  protected Auth auth(HttpExchange ex) throws IOException, SQLException {
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

  protected Map<String, Object> body(HttpExchange ex) throws IOException {
    byte[] bytes = ex.getRequestBody().readAllBytes();
    if (bytes.length == 0) return new LinkedHashMap<>();
    return JSON.readValue(bytes, MAP);
  }

  protected MultipartFile multipartFile(HttpExchange ex) throws IOException {
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

  protected void send(HttpExchange ex, int status, Object value) throws IOException {
    if (value == null) {
      ex.sendResponseHeaders(status, -1);
      ex.close();
      return;
    }
    byte[] bytes = JSON.writeValueAsBytes(value);
    ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    sendBytes(ex, status, bytes);
  }

  protected void sendBytes(HttpExchange ex, int status, byte[] bytes) throws IOException {
    ex.sendResponseHeaders(status, bytes.length);
    try (OutputStream os = ex.getResponseBody()) {
      os.write(bytes);
    }
  }

  protected void addCors(HttpExchange ex) {
    Headers h = ex.getResponseHeaders();
    h.set("Access-Control-Allow-Origin", origin(ex));
    h.set("Access-Control-Allow-Credentials", "true");
    h.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  }

  protected String origin(HttpExchange ex) {
    String requestOrigin = ex.getRequestHeaders().getFirst("Origin");
    if (requestOrigin == null || requestOrigin.isBlank()) return env.value("CORS_ORIGIN", "http://localhost:4200").split(",")[0].trim();
    Set<String> allowed = Set.of(env.value("CORS_ORIGIN", "http://localhost:4200").split(","));
    return allowed.stream().map(String::trim).anyMatch(requestOrigin::equals) ? requestOrigin : allowed.iterator().next().trim();
  }

  protected Map<String, String> query(URI uri) {
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

  protected String decode(String s) {
    return URLDecoder.decode(s, StandardCharsets.UTF_8);
  }

  protected boolean match(String path, String regex) {
    return Pattern.matches(regex, path);
  }

  protected int id(String path) {
    Matcher m = Pattern.compile("(\\d+)").matcher(path);
    return m.find() ? Integer.parseInt(m.group(1)) : 0;
  }

  protected int lastId(String path) {
    Matcher m = Pattern.compile("(\\d+)").matcher(path);
    int id = 0;
    while (m.find()) id = Integer.parseInt(m.group(1));
    return id;
  }

  protected void admin(Auth auth) { if (!"admin".equals(auth.role)) throw new ApiException(403, "Forbidden: Admin access required."); }
  protected void edit(Auth auth) { if (!"admin".equals(auth.role) && !"tester".equals(auth.role)) throw new ApiException(403, "Forbidden: insufficient permissions."); }
  protected Map<String, Object> message(String msg) { return Map.of("message", msg); }
  protected Map<String, Object> error(String msg) { return Map.of("error", msg); }
  protected String placeholders(int count) { return String.join(",", java.util.Collections.nCopies(count, "?")); }
  protected String json(Object v) throws IOException { return v == null ? null : JSON.writeValueAsString(v); }
  protected String str(Object v) { return v == null ? "" : String.valueOf(v); }
  protected Object blankNull(Object v) { return v == null || str(v).isBlank() ? null : v; }
  protected int intValue(Object v, int fallback) { try { return v instanceof Number n ? n.intValue() : Integer.parseInt(str(v)); } catch (Exception e) { return fallback; } }
  protected String trim(String value, int max) { return value == null || value.length() <= max ? value : value.substring(0, max); }
  protected String severity(String line) {
    String l = line.toLowerCase(Locale.ROOT);
    if (l.contains("warning") || l.contains("[warning]") || l.contains(" warn")) return "WARN";
    if (l.matches(".*\\b(errors|failures):\\s*[1-9]\\d*.*") || l.contains("build failure") || l.contains("exception") || l.contains("[error]")) return "ERROR";
    return "INFO";
  }
  protected List<Integer> intList(Object value) {
    List<Integer> out = new ArrayList<>();
    if (value instanceof Iterable<?> iterable) for (Object item : iterable) { int id = intValue(item, 0); if (id > 0 && !out.contains(id)) out.add(id); }
    return out;
  }
  protected List<String> stringList(Object value) {
    List<String> out = new ArrayList<>();
    if (value instanceof Iterable<?> iterable) for (Object item : iterable) { String s = str(item).trim(); if (!s.isBlank() && !out.contains(s)) out.add(s); }
    return out;
  }
  protected List<Object> prepend(Object first, List<?> values) {
    List<Object> out = new ArrayList<>();
    out.add(first);
    out.addAll(values);
    return out;
  }
  protected List<Integer> dependencyIds(int id) {
    try { return db.rows("SELECT dependency_script_id FROM script_dependencies WHERE script_id = ? ORDER BY dependency_script_id", id).stream().map(r -> intValue(r.get("dependencyScriptId"), 0)).toList(); }
    catch (Exception ignored) { return List.of(); }
  }
  protected boolean hasAssignedScripts(int userId, List<Integer> scriptIds) throws SQLException {
    List<Integer> unique = scriptIds.stream().filter(id -> id > 0).distinct().toList();
    if (unique.isEmpty()) return true;
    Number count = (Number) db.one("SELECT COUNT(DISTINCT script_id)::int AS count FROM script_assignments WHERE user_id = ? AND script_id IN (" + placeholders(unique.size()) + ")", prepend(userId, unique).toArray()).get("count");
    return count.intValue() == unique.size();
  }
  protected void requireScriptAccess(Auth auth, int scriptId) throws SQLException {
    if (!"tester".equals(auth.role)) return;
    int count = intValue(db.one("SELECT COUNT(*)::int AS count FROM script_assignments WHERE user_id = ? AND script_id = ?", auth.userId, scriptId).get("count"), 0);
    if (count == 0) throw new ApiException(403, "Access denied: This script is not assigned to you.");
  }
  protected List<Integer> resolveScriptExecutionPlan(List<Integer> requested) {
    LinkedHashSet<Integer> expanded = new LinkedHashSet<>();
    LinkedHashSet<Integer> visiting = new LinkedHashSet<>();
    for (Integer id : requested) resolveScriptDependencies(id, expanded, visiting);
    return new ArrayList<>(expanded);
  }
  protected void resolveScriptDependencies(Integer id, LinkedHashSet<Integer> expanded, LinkedHashSet<Integer> visiting) {
    if (id == null || id <= 0 || expanded.contains(id) || visiting.contains(id)) return;
    visiting.add(id);
    for (Integer dep : dependencyIds(id)) resolveScriptDependencies(dep, expanded, visiting);
    visiting.remove(id);
    expanded.add(id);
  }
  protected Map<String, Object> userDto(Map<String, Object> u) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("id", u.get("id")); out.put("username", u.get("username")); out.put("email", u.get("email")); out.put("fullName", u.get("fullName")); out.put("role", u.get("role")); out.put("avatarUrl", u.get("avatarUrl"));
    return out;
  }
  protected Path resolveScriptPath(Object filePath) {
    String value = str(filePath);
    if (value.isBlank()) return automationWorkspace();
    Path p = Path.of(value);
    if (p.isAbsolute()) return p;
    Path workspace = automationWorkspace();
    List<Path> candidates = List.of(
        workspace.resolve(p),
        workspace.resolve("src").resolve("test").resolve("java").resolve(p),
        workspace.resolve("src").resolve("main").resolve("java").resolve(p),
        Path.of(env.value("ST_AUTOMATION_IMPORT_PATH", "automation-scripts")).resolve(p));
    for (Path candidate : candidates) if (Files.exists(candidate)) return candidate;
    Path byName = findFileByName(workspace, p.getFileName().toString());
    return byName == null ? candidates.get(0) : byName;
  }

  protected Path automationWorkspace() {
    if (env.value("ST_AUTOMATION_SOURCE", "git").equalsIgnoreCase("git")) {
      return Path.of(env.value("ST_AUTOMATION_GIT_CACHE_PATH", env.value("ST_AUTOMATION_PATH", "automation-scripts")));
    }
    return Path.of(env.value("ST_AUTOMATION_PATH", "automation-scripts"));
  }

  protected Path resolveImportPath(Path workspace, String importName) {
    if (importName == null || importName.isBlank() || importName.endsWith(".*")) return null;
    Path relative = Path.of(importName.replace('.', File.separatorChar) + ".java");
    List<Path> candidates = List.of(
        workspace.resolve("src").resolve("test").resolve("java").resolve(relative),
        workspace.resolve("src").resolve("main").resolve("java").resolve(relative),
        workspace.resolve(relative));
    for (Path candidate : candidates) if (Files.exists(candidate)) return candidate;
    return findFileByName(workspace, relative.getFileName().toString());
  }

  protected Path resolveResourceReference(Path scriptPath, Path workspace, String reference) {
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

  protected Path findFileByName(Path root, String fileName) {
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

  protected List<String> javaImports(String source) {
    List<String> imports = new ArrayList<>();
    Matcher m = Pattern.compile("(?m)^\\s*import\\s+(?:static\\s+)?([a-zA-Z_][\\w.]*)(?:\\.\\*)?\\s*;").matcher(source == null ? "" : source);
    while (m.find()) imports.add(m.group(1));
    return imports;
  }

  protected List<String> javaMethods(String source) {
    List<String> methods = new ArrayList<>();
    Matcher m = Pattern.compile("(?m)^\\s*(?:public|protected|private)?\\s*(?:static\\s+)?(?:final\\s+)?[\\w<>\\[\\], ?]+\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\([^;{}]*\\)\\s*(?:throws\\s+[\\w.,\\s]+)?\\{").matcher(source == null ? "" : source);
    while (m.find()) {
      String name = m.group(1);
      if (!Set.of("if", "for", "while", "switch", "catch").contains(name)) methods.add(name);
    }
    return methods;
  }

  protected List<String> javaTestMethods(String source) {
    List<String> methods = new ArrayList<>();
    boolean pendingTest = false;
    for (String line : (source == null ? "" : source).split("\\R")) {
      String trimmed = line.trim();
      if (trimmed.startsWith("@Test")) {
        pendingTest = !trimmed.matches(".*\\benabled\\s*=\\s*false\\b.*");
        continue;
      }
      if (trimmed.startsWith("@")) continue;
      Matcher method = Pattern.compile("^(?:public|protected|private)?\\s*(?:static\\s+)?(?:final\\s+)?[\\w<>\\[\\], ?]+\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\([^;{}]*\\)\\s*(?:throws\\s+[\\w.,\\s]+)?\\{?\\s*$").matcher(trimmed);
      if (pendingTest && method.find()) {
        methods.add(method.group(1));
        pendingTest = false;
      } else if (!trimmed.isEmpty() && !trimmed.startsWith("//")) {
        pendingTest = false;
      }
    }
    return methods;
  }

  protected String inferPrimaryMethod(String source) {
    List<String> testMethods = javaTestMethods(source);
    if (!testMethods.isEmpty()) return testMethods.get(0);
    List<String> methods = javaMethods(source);
    return methods.isEmpty() ? "" : methods.get(0);
  }
  protected String className(String source, String fileName) {
    String pkg = packageName(source);
    Matcher m = Pattern.compile("(?m)^\\s*(?:public\\s+)?(?:class|interface|enum|record)\\s+([A-Za-z_][A-Za-z0-9_]*)").matcher(source);
    String simple = m.find() ? m.group(1) : fileName.replaceFirst("(?i)\\.java$", "");
    return pkg == null ? simple : pkg + "." + simple;
  }
  protected String packageName(String source) {
    Matcher m = Pattern.compile("(?m)^\\s*package\\s+([a-zA-Z_][\\w.]*)\\s*;").matcher(source);
    return m.find() ? m.group(1) : null;
  }
  protected String buildTestNgXml(String runName, List<Map<String, Object>> scripts) {
    StringBuilder xml = new StringBuilder("<!DOCTYPE suite SYSTEM \"https://testng.org/testng-1.0.dtd\">\n<suite name=\"").append(escapeXml(runName)).append("\">\n  <test name=\"Noesis Test\">\n    <classes>\n");
    for (Map<String, Object> script : scripts) xml.append("      <class name=\"").append(escapeXml(str(script.get("className")))).append("\"/>\n");
    return xml.append("    </classes>\n  </test>\n</suite>\n").toString();
  }
  protected String escapeXml(String s) { return s.replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;"); }

  static final class Auth {
    final int userId;
    final String role;
    final String username;

    Auth(int userId, String role, String username) {
      this.userId = userId;
      this.role = role;
      this.username = username;
    }
  }

  static final class MultipartFile {
    final String fileName;
    final byte[] bytes;

    MultipartFile(String fileName, byte[] bytes) {
      this.fileName = fileName;
      this.bytes = bytes;
    }
  }

  static final class ResultSummary {
    final int passed;
    final int failed;
    final int errors;
    final int skipped;

    ResultSummary(int passed, int failed, int errors, int skipped) {
      this.passed = passed;
      this.failed = failed;
      this.errors = errors;
      this.skipped = skipped;
    }

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
