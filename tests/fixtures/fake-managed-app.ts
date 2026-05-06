import http from "node:http";

const port = Number(process.env.PORT);
const host = process.env.HOST ?? "127.0.0.1";

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    app: process.env.RELAYBASE_APP_ID,
    port: process.env.PORT,
    baseUrl: process.env.RELAYBASE_BASE_URL,
    url: request.url
  }));
});

server.listen(port, host, () => {
  console.log(`fake app listening ${host}:${port}`);
});

process.once("SIGTERM", () => server.close(() => process.exit(0)));
process.once("SIGINT", () => server.close(() => process.exit(0)));

