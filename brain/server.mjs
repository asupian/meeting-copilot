// The panel's transport: plain HTTP + Server-Sent Events, no dependencies.
// This file knows NOTHING about meetings — it serves the page, replays a
// state snapshot to new SSE clients, fans events out, and hands POSTs to
// callbacks. All meeting semantics stay in live.mjs.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

export function makePanelServer({ port, panelPath, snapshot, onTalk, onOpen, onFeedback }) {
  const clients = new Set();

  function broadcast(obj) {
    const payload = `data: ${JSON.stringify(obj)}\n\n`;
    for (const res of clients) { try { res.write(payload); } catch {} }
  }

  const readBody = (req, cb) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => { let j = null; try { j = JSON.parse(body); } catch {} cb(j); });
  };

  const server = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/index.html"))) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(panelPath, "utf8"));   // read fresh: panel edits land on reload
      return;
    }
    if (req.method === "GET" && req.url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      for (const ev of snapshot()) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "POST" && req.url === "/talk") {
      readBody(req, (j) => { onTalk(j); res.writeHead(204).end(); });
      return;
    }
    if (req.method === "POST" && req.url === "/open") {
      // onOpen resolves + acts (whitelisting lives with the caller, who knows
      // the repo layout); truthy = handled.
      readBody(req, (j) => { res.writeHead(onOpen(j) ? 204 : 404).end(); });
      return;
    }
    if (req.method === "POST" && req.url === "/feedback") {
      readBody(req, (j) => { onFeedback(j); res.writeHead(204).end(); });
      return;
    }
    res.writeHead(404).end();
  });

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`live: port ${port} already in use. Another copilot is running — kill it (lsof -ti:${port} | xargs kill) or pass --port.`);
      process.exit(1);
    }
    throw e;
  });

  return { server, broadcast };
}
