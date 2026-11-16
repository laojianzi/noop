import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { createServer } from "node:https";
import { join } from "node:path";

export async function startHttpsProxy(out: string, targetPort: number) {
  const key = join(out, "proxy.key"), cert = join(out, "proxy.crt");
  const openssl = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { encoding: "utf8" });
  if (openssl.status !== 0) throw new Error(`could not create the synthetic proxy certificate: ${openssl.stderr}`);
  const headersFor = (req: IncomingMessage) => {
    const h = { ...req.headers };
    if (h["x-test-drop-forwarded"]) { delete h["x-forwarded-for"]; delete h["x-test-drop-forwarded"]; }
    else h["x-forwarded-for"] = [h["x-forwarded-for"], req.socket.remoteAddress].filter(Boolean).join(", ");
    h["x-forwarded-proto"] = String(h["x-test-forwarded-proto"] || "https");
    h["x-forwarded-host"] = String(h["x-test-forwarded-host"] || req.headers.host || "");
    delete h["x-test-forwarded-proto"]; delete h["x-test-forwarded-host"]; return h;
  };
  const sockets = new Set<any>();
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const upstream = httpRequest({ hostname: "127.0.0.1", port: targetPort, localAddress: "127.0.0.3", method: req.method, path: req.url, headers: headersFor(req) }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers); r.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (req, socket, head) => {
    const upstream = httpRequest({ hostname: "127.0.0.1", port: targetPort, localAddress: "127.0.0.3", method: req.method, path: req.url, headers: headersFor(req) });
    upstream.on("upgrade", (response, other, first) => {
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${response.rawHeaders.reduce((s, h, i, a) => i % 2 ? s : `${s}${h}: ${a[i + 1]}\r\n`, "")}\r\n`);
      if (first.length) socket.write(first); if (head.length) other.write(head);
      socket.on("error", () => other.destroy()); other.on("error", () => socket.destroy()); socket.pipe(other).pipe(socket);
    });
    upstream.on("response", (response) => { socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`); response.pipe(socket); });
    upstream.on("error", () => socket.destroy()); upstream.end();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { port: (server.address() as { port: number }).port, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((ok) => server.close(() => ok()));
  } };
}
