import http from "node:http";

const port = Number(process.env.PORT);
const host = process.env.HOST ?? "127.0.0.1";
const readyAt = Date.now() + Number(process.env.HEALTH_READY_DELAY_MS ?? 0);

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    if (Date.now() < readyAt) {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("warming");
      return;
    }

    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }

  if (request.url?.startsWith("/emit-log")) {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    console.log(url.searchParams.get("message") ?? "fixture emitted log");
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("logged");
    return;
  }

  if (request.url === "/shutdown") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("shutting down", () => server.close(() => process.exit(0)));
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      app: process.env.RELAYBASE_APP_ID,
      port: process.env.PORT,
      baseUrl: process.env.RELAYBASE_BASE_URL,
      url: request.url
    })
  );
});

server.listen(port, host, () => {
  console.log(`fake app listening ${host}:${port}`);
});

process.once("SIGTERM", () => server.close(() => process.exit(0)));
process.once("SIGINT", () => server.close(() => process.exit(0)));
