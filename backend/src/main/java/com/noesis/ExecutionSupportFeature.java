package com.noesis;


import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
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

class ExecutionSupportFeature extends UserManagementFeature {
  private static final Object AUTOMATION_WORKSPACE_LOCK = new Object();

  protected void startExecution(int runId, String runName, String testngXml, List<Map<String, Object>> scripts) {
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
        db.update("UPDATE execution_runs SET status = ?::run_status, passed_count = ?, failed_count = ?, error_count = ?, skipped_count = ?, completed_at = NOW(), duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at))::int * 1000, run_metadata = COALESCE(run_metadata, '{}'::jsonb) || ?::jsonb WHERE id = ?",
            status, summary.passed, summary.failed, summary.errors, summary.skipped,
            json(Map.of("executionSource", env.value("ST_AUTOMATION_SOURCE", "git"), "workspacePath", workspace.toString(), "finalStatus", status, "exitCode", exit,
                "completedAt", Instant.now().toString(), "resultSummary", Map.of("passed", summary.passed, "failed", summary.failed, "errors", summary.errors, "skipped", summary.skipped))), runId);
        db.update("UPDATE execution_results SET status = ?::result_status, completed_at = NOW(), log_output = ? WHERE run_id = ?", status, out.toString(), runId);
        logExecution(runId, exit == 0 ? "INFO" : "ERROR", "Execution completed with status: " + status + ".");
        try {
          createExecutionOutputArtifacts(runId, runName, status, summary, out.toString());
          int artifactCount = collectExecutionArtifacts(runId, workspace, scripts);
          db.update("UPDATE execution_runs SET run_metadata = COALESCE(run_metadata, '{}'::jsonb) || ?::jsonb WHERE id = ?",
              json(Map.of("artifactCount", artifactCount)), runId);
        } catch (Exception artifactError) {
          logExecution(runId, "WARN", "Execution artifacts could not be finalized: " + artifactError.getMessage());
        }
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
    }, executionExecutor);
  }

  protected void logExecution(int runId, String severity, String detail) throws SQLException {
    db.update("INSERT INTO execution_logs (run_id, log_level, message, detailed_description, source_component, timestamp) VALUES (?, ?::log_level, ?, ?, 'java-execution-runner', NOW())", runId, severity, trim(detail, 4000), detail);
  }

  protected List<String> mavenCommand() {
    String home = env.value("MAVEN_HOME", "").trim();
    if (!home.isBlank()) {
      Path mvn = Path.of(home, "bin", isWindows() ? "mvn.cmd" : "mvn");
      if (Files.exists(mvn)) return new ArrayList<>(List.of(mvn.toString()));
    }
    return new ArrayList<>(List.of(isWindows() ? "mvn.cmd" : "mvn"));
  }

  protected boolean isWindows() {
    return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
  }

  protected Path resolveExecutionWorkspace(int runId) throws IOException, InterruptedException, SQLException {
    if (!env.value("ST_AUTOMATION_SOURCE", "git").equalsIgnoreCase("git")) {
      Path source = Path.of(env.value("ST_AUTOMATION_PATH", "automation-scripts"));
      Path workspace = executionWorkspaceRoot(source).resolve("run-" + runId);
      recreateDirectory(workspace);
      copyDirectory(source, workspace);
      return workspace;
    }
    Path cache = Path.of(env.value("ST_AUTOMATION_GIT_CACHE_PATH", env.value("ST_AUTOMATION_PATH", "automation-scripts")));
    String repo = env.value("ST_AUTOMATION_GIT_REPO_URL", "").trim();
    String branch = env.value("ST_AUTOMATION_GIT_BRANCH", "main").trim();
    Path workspace = executionWorkspaceRoot(cache).resolve("run-" + runId);
    synchronized (AUTOMATION_WORKSPACE_LOCK) {
      if (repo.isBlank()) {
        logExecution(runId, "WARN", "ST_AUTOMATION_GIT_REPO_URL is not configured. Isolating execution from existing git cache: " + cache);
        recreateDirectory(workspace);
        copyDirectory(cache, workspace);
        return workspace;
      }
      Files.createDirectories(parentOrCurrent(cache));
      if (!Files.exists(cache.resolve(".git"))) {
        logExecution(runId, "INFO", "Cloning automation repository: " + repo);
        runCommand(runId, parentOrCurrent(cache), "git", "clone", "--depth", "1", repo, cache.toString());
      } else {
        logExecution(runId, "INFO", "Fetching latest automation repository changes.");
        runCommand(runId, cache, "git", "fetch", "origin", "--prune", "--depth", "1");
        if (!branch.isBlank()) {
          runCommand(runId, cache, "git", "checkout", "-B", branch, "origin/" + branch);
          runCommand(runId, cache, "git", "reset", "--hard", "origin/" + branch);
        }
      }
      deleteDirectory(workspace);
      try {
        String ref = branch.isBlank() ? "HEAD" : "origin/" + branch;
        runCommand(runId, cache, "git", "worktree", "prune");
        runCommand(runId, cache, "git", "worktree", "add", "--detach", "--force", workspace.toString(), ref);
      } catch (Exception worktreeError) {
        logExecution(runId, "WARN", "Git worktree isolation failed. Falling back to directory copy: " + worktreeError.getMessage());
        recreateDirectory(workspace);
        copyDirectory(cache, workspace);
      }
    }
    return workspace;
  }

  protected Path resolveSyncWorkspace() throws IOException, InterruptedException {
    if (!env.value("ST_AUTOMATION_SOURCE", "git").equalsIgnoreCase("git")) {
      return Path.of(env.value("ST_AUTOMATION_PATH", "automation-scripts"));
    }
    Path cache = Path.of(env.value("ST_AUTOMATION_GIT_CACHE_PATH", env.value("ST_AUTOMATION_PATH", "automation-scripts")));
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

  protected void runCommand(int runId, Path cwd, String... command) throws IOException, InterruptedException, SQLException {
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

  protected void runPlainCommand(Path cwd, String... command) throws IOException, InterruptedException {
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

  protected Path executionWorkspaceRoot(Path source) throws IOException {
    String configured = env.value("ST_AUTOMATION_RUN_WORKSPACE_ROOT", "").trim();
    if (!configured.isBlank()) {
      Path root = Path.of(configured);
      Files.createDirectories(root);
      return root;
    }
    Path parent = parentOrCurrent(source);
    Path root = parent.resolve("noesis-execution-workspaces");
    Files.createDirectories(root);
    return root;
  }

  protected Path parentOrCurrent(Path path) {
    Path absolute = path.toAbsolutePath().normalize();
    Path parent = absolute.getParent();
    return parent == null ? Path.of(".").toAbsolutePath().normalize() : parent;
  }

  protected void recreateDirectory(Path directory) throws IOException {
    deleteDirectory(directory);
    Files.createDirectories(directory);
  }

  protected void deleteDirectory(Path directory) throws IOException {
    if (!Files.exists(directory)) return;
    try (var paths = Files.walk(directory)) {
      for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) {
        Files.deleteIfExists(path);
      }
    }
  }

  protected void copyDirectory(Path source, Path target) throws IOException {
    Path normalizedSource = source.toAbsolutePath().normalize();
    Set<String> skipDirs = Set.of(".git", "target", "node_modules", "bin", "obj", "dist", "build", ".cache");
    try (var paths = Files.walk(normalizedSource)) {
      for (Path current : paths.toList()) {
        if (current.equals(normalizedSource)) continue;
        Path relative = normalizedSource.relativize(current);
        boolean skip = false;
        for (Path part : relative) {
          if (skipDirs.contains(part.toString().toLowerCase(Locale.ROOT))) {
            skip = true;
            break;
          }
        }
        if (skip) continue;
        Path destination = target.resolve(relative.toString());
        if (Files.isDirectory(current)) {
          Files.createDirectories(destination);
        } else {
          Files.createDirectories(destination.getParent());
          Files.copy(current, destination, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.COPY_ATTRIBUTES);
        }
      }
    }
  }

  protected List<Path> javaFiles(Path root) throws IOException {
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

  protected boolean isConfigJava(String fileName, String source) {
    String cleaned = stripJavaComments(source);
    boolean hasTestAnnotation = Pattern.compile("@\\s*(Test|TestMetadata|ScriptMetadata)\\b").matcher(cleaned).find();
    String lower = fileName.toLowerCase(Locale.ROOT);
    return !hasTestAnnotation && (lower.contains("config") || lower.contains("configuration"));
  }

  protected String stripJavaComments(String source) {
    return (source == null ? "" : source).replaceAll("/\\*[\\s\\S]*?\\*/", " ").replaceAll("//[^\\r\\n]*", "");
  }

  protected int collectExecutionArtifacts(int runId, Path workspace, List<Map<String, Object>> scripts) {
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

  protected boolean isReportArtifact(Path path) {
    String name = path.getFileName().toString().toLowerCase(Locale.ROOT);
    return name.endsWith(".html") || name.endsWith(".htm") || name.endsWith(".pdf");
  }

  protected Object scriptIdForArtifact(Path path, List<Map<String, Object>> scripts) {
    String name = path.getFileName().toString().toLowerCase(Locale.ROOT);
    for (Map<String, Object> script : scripts) {
      String scriptName = str(script.get("name")).toLowerCase(Locale.ROOT);
      if (!scriptName.isBlank() && name.contains(scriptName)) return script.get("id");
    }
    return null;
  }

  protected void saveArtifact(int runId, Object scriptId, String type, Path source) throws IOException, SQLException {
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

  protected Path reportsDirectory(int runId) {
    Path base = Path.of(env.value("ST_AUTOMATION_REPORTS_PATH", env.value("ST_AUTOMATION_PATH", "automation-scripts") + File.separator + "noesis-reports"));
    return base.resolve("run-" + runId);
  }

  protected Path surefireReportsDirectory(Path workspace) {
    return workspace.resolve("target").resolve("surefire-reports");
  }

  protected String artifactType(Path path) {
    String name = path.getFileName().toString().toLowerCase(Locale.ROOT);
    if (name.endsWith(".xml")) return "xml";
    if (name.endsWith(".html") || name.endsWith(".htm")) return "html";
    if (name.endsWith(".pdf")) return "pdf";
    if (name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg")) return "screenshot";
    if (name.endsWith(".log") || name.endsWith(".txt")) return "log";
    return "artifact";
  }

  protected boolean displayArtifact(Map<String, Object> artifact, List<String> scriptNames) {
    String fileName = str(artifact.get("fileName")).toLowerCase(Locale.ROOT);
    if (fileName.equals("execution-output.html") || fileName.equals("execution-output.pdf")) return true;
    if (fileName.equals("index.html") || fileName.equals("emailable-report.html") || fileName.equals("testng-results.xml")) return false;
    if (fileName.startsWith("testng-") || fileName.startsWith("surefire")) return false;
    return fileName.endsWith(".html") || fileName.endsWith(".pdf");
  }

  protected boolean isGeneratedOutputArtifact(String fileName) {
    String name = fileName.toLowerCase(Locale.ROOT);
    return name.equals("execution-output.html") || name.equals("execution-output.pdf");
  }

  protected String mimeType(Path path) throws IOException {
    String detected = Files.probeContentType(path);
    if (detected != null) return detected;
    String name = path.getFileName().toString().toLowerCase(Locale.ROOT);
    if (name.endsWith(".pdf")) return "application/pdf";
    if (name.endsWith(".xml")) return "application/xml";
    if (name.endsWith(".html") || name.endsWith(".htm")) return "text/html";
    if (name.endsWith(".txt") || name.endsWith(".log")) return "text/plain";
    return "application/octet-stream";
  }

  protected void createExecutionOutputArtifacts(int runId, String runName, String status, ResultSummary summary, String output) {
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

  protected void ensureOutputArtifactsForRun(int runId) {
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

  protected void writeSimplePdf(Path path, List<String> sections) throws IOException {
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

  protected String htmlEscape(String value) {
    return (value == null ? "" : value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
  }

  protected String pdfEscape(String value) {
    return (value == null ? "" : value).replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)").replaceAll("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]", " ");
  }

  protected void sendMail(List<String> recipients, String subject, String text, List<Map<String, Object>> artifacts) throws MessagingException {
    Properties props = new Properties();
    props.put("mail.smtp.auth", "true");
    props.put("mail.smtp.host", env.value("SMTP_HOST", ""));
    props.put("mail.smtp.port", env.value("SMTP_PORT", "587"));
    props.put("mail.smtp.starttls.enable", String.valueOf(!Boolean.parseBoolean(env.value("SMTP_SECURE", "false"))));
    props.put("mail.smtp.ssl.enable", env.value("SMTP_SECURE", "false"));
    props.put("mail.smtp.connectiontimeout", "15000");
    props.put("mail.smtp.timeout", "30000");
    props.put("mail.smtp.writetimeout", "30000");

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
    String content = text == null || text.isBlank() ? "Please find the selected execution artifacts attached." : text;
    if (content.trim().startsWith("<")) {
      body.setContent(content, "text/html; charset=UTF-8");
    } else {
      body.setText(content, StandardCharsets.UTF_8.name());
    }
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

  protected boolean mailConfigured() {
    return Boolean.parseBoolean(env.value("MAIL_ENABLED", "false"))
        && !env.value("SMTP_HOST", "").isBlank()
        && !env.value("SMTP_USER", "").isBlank()
        && !env.value("SMTP_PASSWORD", "").isBlank()
        && !env.value("MAIL_FROM", env.value("SMTP_USER", "")).isBlank();
  }

  protected void sendExecutionCompletionMail(int runId, String runName, String status, ResultSummary summary, String errorMessage) {
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
      String triggeredByName = str(run.get("triggeredByName")).isBlank() ? "User " + triggeredBy : str(run.get("triggeredByName"));
      String html = runCompletionEmailHtml(runId, runName, finalStatus, str(run.getOrDefault("environment", "local")), triggeredByName,
          str(run.get("startedAt")), str(run.get("completedAt")), formatDuration(run.get("durationMs")),
          intValue(run.get("totalScripts"), summary.total()), summary, errorMessage, runUrl);
      sendMail(recipients, subject, html, List.of());
      logExecution(runId, "INFO", "Execution email notification sent to " + recipients.size() + " recipient(s).");
    } catch (Exception e) {
      try { logExecution(runId, "WARN", "Execution email notification failed: " + e.getMessage()); } catch (Exception ignored) {}
    }
  }

  @SuppressWarnings("unchecked")
  protected Map<String, Object> enrichRunMetadata(Map<String, Object> run) {
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

  protected String resolveExecutionAppUrl(int runId, Map<String, Object> run, Map<String, Object> metadata) {
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

  protected String resolveExecutionAppUrlFromWorkspace(Path workspace, int runId) {
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

  protected String extractPreferredUrl(String text) {
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

  protected boolean isApplicationUrl(String value) {
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

  protected boolean isHttpUrl(String value) {
    return value != null && Pattern.compile("^https?://", Pattern.CASE_INSENSITIVE).matcher(value.trim()).find();
  }

  protected boolean isFrontendOrLocalNoesisUrl(String value) {
    String url = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
    if (url.isBlank()) return true;
    String frontend = env.value("APP_BASE_URL", "").trim().toLowerCase(Locale.ROOT);
    return url.equals(frontend) || url.contains("localhost:4200") || url.contains("127.0.0.1:4200");
  }

  protected String gitRepositoryUrl() {
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

  protected String gitRepositoryName() {
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

  protected void putDefault(Map<String, Object> map, String key, Object value) {
    if (str(map.get(key)).isBlank() && value != null && !str(value).isBlank()) map.put(key, value);
  }

  protected String firstNonBlank(String... values) {
    for (String value : values) if (value != null && !value.isBlank()) return value;
    return "";
  }

  protected Object nextRunAt(String cron, boolean oneTime) {
    try {
      String[] parts = cron == null ? new String[0] : cron.trim().split("\\s+");
      if (parts.length < 5) return null;
      if (oneTime) {
        int minute = Integer.parseInt(parts[0]);
        int hour = Integer.parseInt(parts[1]);
        int day = Integer.parseInt(parts[2]);
        int month = Integer.parseInt(parts[3]);
        int year = java.time.LocalDate.now().getYear();
        java.time.LocalDateTime dt = java.time.LocalDateTime.of(year, month, day, hour, minute);
        if (dt.isBefore(java.time.LocalDateTime.now())) dt = dt.plusYears(1);
        return Timestamp.valueOf(dt);
      }
      java.time.LocalDateTime now = java.time.LocalDateTime.now();
      java.time.LocalDateTime candidate = now.withSecond(0).withNano(0).plusMinutes(1);
      for (int i = 0; i < 10080; i++) {
        int cronDow = candidate.getDayOfWeek().getValue() == 7 ? 0 : candidate.getDayOfWeek().getValue();
        if (cronField(candidate.getMinute(), parts[0])
            && cronField(candidate.getHour(), parts[1])
            && cronField(candidate.getDayOfMonth(), parts[2])
            && cronField(candidate.getMonthValue(), parts[3])
            && cronField(cronDow, parts[4])) {
          return Timestamp.valueOf(candidate);
        }
        candidate = candidate.plusMinutes(1);
      }
      return null;
    } catch (Exception ignored) {
      return null;
    }
  }

  protected String runCompletionEmailHtml(int runId, String runName, String status, String environment, String triggeredBy,
      String startedAt, String completedAt, String duration, int totalScripts, ResultSummary summary, String errorMessage, String runUrl) {
    boolean passed = "passed".equals(status);
    String normalizedStatus = status == null || status.isBlank() ? "failed" : status.toLowerCase(Locale.ROOT);
    String statusLabel = normalizedStatus.toUpperCase(Locale.ROOT);
    String statusColor = passed ? "#047857" : "#b91c1c";
    String statusBg = passed ? "#ecfdf5" : "#fef2f2";
    String accent = passed ? "#059669" : "#dc2626";
    String intro = passed
        ? "Execution completed successfully. No failures or errors were reported."
        : "Execution completed with failures or errors. Please review the run details and attached artifacts.";
    int failedTotal = summary.failed + summary.errors;
    int displayTotal = Math.max(totalScripts, summary.total());
    int passRate = displayTotal <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((summary.passed * 100f) / displayTotal)));
    String safeRunName = htmlEscape(runName);
    String safeEnvironment = htmlEscape(environment == null || environment.isBlank() ? "local" : environment);
    String safeTriggeredBy = htmlEscape(triggeredBy);
    String safeStartedAt = htmlEscape(formatEmailDate(startedAt));
    String safeCompletedAt = htmlEscape(formatEmailDate(completedAt));
    String safeDuration = htmlEscape(duration == null || duration.isBlank() ? "N/A" : duration);
    String errorPanel = errorMessage == null || errorMessage.isBlank() ? "" : """
              <tr>
                <td style="padding:0 28px 22px 28px">
                  <table role="presentation" width="100%%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px">
                    <tr>
                      <td style="padding:14px 16px">
                        <div style="font-size:12px;font-weight:700;color:#9a3412;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Attention required</div>
                        <div style="font-size:14px;line-height:1.6;color:#7c2d12">%s</div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
        """.formatted(htmlEscape(errorMessage));
    String link = runUrl == null || runUrl.isBlank() ? "" : """
              <tr>
                <td style="padding:0 28px 30px 28px">
                  <a href="%s" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-size:14px;font-weight:700">Open Run Details</a>
                </td>
              </tr>
        """.formatted(htmlEscape(runUrl));
    return """
        <!doctype html>
        <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <meta name="color-scheme" content="light">
          <meta name="supported-color-schemes" content="light">
          <title>Noesis Execution Summary</title>
        </head>
        <body style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;color:#111827">
          <div style="display:none;max-height:0;overflow:hidden;opacity:0">%s</div>
          <table role="presentation" width="100%%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#f4f7fb">
            <tr>
              <td align="center" style="padding:30px 14px">
                <table role="presentation" width="680" cellspacing="0" cellpadding="0" style="width:680px;max-width:100%%;border-collapse:collapse;background:#ffffff;border:1px solid #d9e2ef;border-radius:12px;overflow:hidden">
                  <tr>
                    <td style="padding:22px 28px;border-top:5px solid %s;border-bottom:1px solid #e5e7eb;background:#ffffff">
                      <table role="presentation" width="100%%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">
                        <tr>
                          <td style="vertical-align:top">
                            <div style="font-size:12px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.08em">Noesis Testing Platform</div>
                            <h1 style="margin:7px 0 0 0;color:#111827;font-size:22px;line-height:1.25;font-weight:700">Execution Report</h1>
                          </td>
                          <td align="right" style="white-space:nowrap;vertical-align:top">
                            <span style="display:inline-block;background:%s;color:%s;border:1px solid %s;border-radius:999px;padding:7px 12px;font-size:12px;font-weight:800;letter-spacing:.04em">%s</span>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:24px 28px 18px 28px">
                      <div style="font-size:18px;line-height:1.35;font-weight:700;color:#111827;margin-bottom:8px">%s</div>
                      <div style="font-size:14px;line-height:1.6;color:#4b5563">%s</div>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 28px 22px 28px">
                      <table role="presentation" width="100%%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">
                        <tr>
                          <td width="25%%" style="background:#f8fafc;border:1px solid #e5e7eb;padding:14px 10px;text-align:center">
                            <div style="font-size:22px;font-weight:800;color:#111827">%d</div>
                            <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.04em">Total</div>
                          </td>
                          <td width="25%%" style="background:#f0fdf4;border:1px solid #bbf7d0;padding:14px 10px;text-align:center">
                            <div style="font-size:24px;font-weight:800;color:#047857">%d</div>
                            <div style="font-size:11px;font-weight:700;color:#047857;text-transform:uppercase;letter-spacing:.04em">Passed</div>
                          </td>
                          <td width="25%%" style="background:#fef2f2;border:1px solid #fecaca;padding:14px 10px;text-align:center">
                            <div style="font-size:24px;font-weight:800;color:#be123c">%d</div>
                            <div style="font-size:11px;font-weight:700;color:#be123c;text-transform:uppercase;letter-spacing:.04em">Failed</div>
                          </td>
                          <td width="25%%" style="background:#eff6ff;border:1px solid #bfdbfe;padding:14px 10px;text-align:center">
                            <div style="font-size:24px;font-weight:800;color:#1d4ed8">%d%%</div>
                            <div style="font-size:11px;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:.04em">Pass Rate</div>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 28px 22px 28px">
                      <table role="presentation" width="100%%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e5e7eb">
                        <tr>
                          <td colspan="2" style="padding:12px 16px;background:#f9fafb;color:#111827;font-size:14px;font-weight:700;border-bottom:1px solid #e5e7eb">Run Details</td>
                        </tr>
                        <tr>
                          <td style="padding:11px 16px;color:#6b7280;font-size:13px;width:34%%;border-bottom:1px solid #f1f5f9">Run</td>
                          <td style="padding:11px 16px;color:#111827;font-size:14px;font-weight:600;border-bottom:1px solid #f1f5f9">%s (#%d)</td>
                        </tr>
                        <tr>
                          <td style="padding:11px 16px;color:#6b7280;font-size:13px;border-bottom:1px solid #f1f5f9">Environment</td>
                          <td style="padding:11px 16px;color:#111827;font-size:14px;border-bottom:1px solid #f1f5f9">%s</td>
                        </tr>
                        <tr>
                          <td style="padding:11px 16px;color:#6b7280;font-size:13px;border-bottom:1px solid #f1f5f9">Triggered By</td>
                          <td style="padding:11px 16px;color:#111827;font-size:14px;border-bottom:1px solid #f1f5f9">%s</td>
                        </tr>
                        <tr>
                          <td style="padding:11px 16px;color:#6b7280;font-size:13px;border-bottom:1px solid #f1f5f9">Started</td>
                          <td style="padding:11px 16px;color:#111827;font-size:14px;border-bottom:1px solid #f1f5f9">%s</td>
                        </tr>
                        <tr>
                          <td style="padding:11px 16px;color:#6b7280;font-size:13px;border-bottom:1px solid #f1f5f9">Completed</td>
                          <td style="padding:11px 16px;color:#111827;font-size:14px;border-bottom:1px solid #f1f5f9">%s</td>
                        </tr>
                        <tr>
                          <td style="padding:11px 16px;color:#6b7280;font-size:13px;border-bottom:1px solid #f1f5f9">Duration</td>
                          <td style="padding:11px 16px;color:#111827;font-size:14px;border-bottom:1px solid #f1f5f9">%s</td>
                        </tr>
                        <tr>
                          <td style="padding:11px 16px;color:#6b7280;font-size:13px">Skipped</td>
                          <td style="padding:11px 16px;color:#111827;font-size:14px">%d</td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  %s
                  %s
                  <tr>
                    <td style="padding:16px 28px;background:#f9fafb;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px;line-height:1.5">
                      This is an automated notification from Noesis Testing Platform. Please do not reply to this email.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
        """.formatted(htmlEscape(intro), accent, statusBg, statusColor, statusColor, htmlEscape(statusLabel),
        safeRunName, htmlEscape(intro), displayTotal, summary.passed, failedTotal, passRate,
        safeRunName, runId, safeEnvironment, safeTriggeredBy, safeStartedAt, safeCompletedAt, safeDuration,
        summary.skipped, errorPanel, link);
  }

  protected boolean cronField(int value, String field) {
    if (field == null || field.isBlank()) return false;
    for (String part : field.split(",")) {
      String p = part.trim();
      if (p.equals("*")) return true;
      if (p.startsWith("*/")) {
        int step = Integer.parseInt(p.substring(2));
        if (step > 0 && value % step == 0) return true;
        continue;
      }
      if (p.contains("-")) {
        String[] bounds = p.split("-", 2);
        int start = Integer.parseInt(bounds[0]);
        int end = Integer.parseInt(bounds[1]);
        if (value >= start && value <= end) return true;
        continue;
      }
      if (Integer.parseInt(p) == value) return true;
    }
    return false;
  }

  protected String normalizeEmail(String email) {
    String value = email == null ? "" : email.trim();
    Matcher named = Pattern.compile("<([^>]+)>").matcher(value);
    return named.find() ? named.group(1).trim() : value;
  }

  protected boolean validEmail(String email) {
    return email != null && Pattern.matches("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", email);
  }

  protected String formatDuration(Object value) {
    long ms = intValue(value, 0);
    if (ms <= 0) return "N/A";
    long seconds = ms / 1000;
    long minutes = seconds / 60;
    long hours = minutes / 60;
    if (hours > 0) return hours + "h " + (minutes % 60) + "m";
    if (minutes > 0) return minutes + "m " + (seconds % 60) + "s";
    return seconds + "s";
  }

  protected String formatEmailDate(String value) {
    if (value == null || value.isBlank()) return "N/A";
    try {
      return java.time.format.DateTimeFormatter.ofPattern("dd MMM yyyy, hh:mm a 'UTC'", Locale.ENGLISH)
          .withZone(java.time.ZoneOffset.UTC)
          .format(Instant.parse(value));
    } catch (Exception ignored) {
      return value;
    }
  }

  protected ResultSummary parseTestResults(String output) {
    Matcher m = Pattern.compile("Tests run:\\s*(\\d+),\\s*Failures:\\s*(\\d+),\\s*Errors:\\s*(\\d+),\\s*Skipped:\\s*(\\d+)", Pattern.CASE_INSENSITIVE).matcher(output == null ? "" : output);
    if (!m.find()) return new ResultSummary(0, 0, 0, 0);
    int total = Integer.parseInt(m.group(1));
    int failed = Integer.parseInt(m.group(2));
    int errors = Integer.parseInt(m.group(3));
    int skipped = Integer.parseInt(m.group(4));
    return new ResultSummary(Math.max(0, total - failed - errors - skipped), failed, errors, skipped);
  }

  protected ResultSummary parseTestResultsFromXml(String content) {
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

  protected ResultSummary parseTestResultsFromReports(Path workspace) {
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

  protected ResultSummary finalSummary(int exit, String output, Path workspace, int scriptCount) {
    ResultSummary summary = parseTestResultsFromReports(workspace);
    if (summary == null || summary.total() == 0) summary = parseTestResults(output);
    boolean browserFailure = Pattern.compile("NoSuchSessionException|invalid session id|browser has closed the connection|disconnected: not connected to DevTools|chrome not reachable", Pattern.CASE_INSENSITIVE)
        .matcher(output == null ? "" : output).find();
    if ((exit != 0 || browserFailure) && summary.failed + summary.errors == 0) {
      return new ResultSummary(summary.passed, Math.max(1, scriptCount - summary.passed - summary.skipped), browserFailure ? 1 : summary.errors, summary.skipped);
    }
    return summary;
  }

}
