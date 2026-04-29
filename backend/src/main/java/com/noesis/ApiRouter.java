package com.noesis;


import com.sun.net.httpserver.HttpExchange;
import java.io.IOException;
import java.util.List;
import java.util.Locale;
import java.util.Map;

class ApiRouter extends AuditLogFeature {
  protected void handle(HttpExchange ex) throws IOException {
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
      else if (path.equals("/api/scripts/categories") && method.equals("GET")) categories(ex, auth);
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

}
