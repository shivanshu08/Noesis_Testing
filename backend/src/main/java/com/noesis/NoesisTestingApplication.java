package com.noesis;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.concurrent.Executors;
public class NoesisTestingApplication extends ApiRouter {
  public static void main(String[] args) throws Exception {
    Env.loadDotenv();
    NoesisTestingApplication app = new NoesisTestingApplication();
    app.start();
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
}