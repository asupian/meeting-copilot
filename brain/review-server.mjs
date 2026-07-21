#!/usr/bin/env node
// review-server.mjs — watch a recording with the copilot's cards popping in at
// the moment they would have appeared live.
//
//   node brain/review-server.mjs --video call.mp4 --transcript t.jsonl \
//        --cards cards.jsonl --anchor 2026-04-27T16:00:00Z [--port 8791]
//
// Cards carry `atSec` (seconds from the first utterance). The video starts at
// `anchor`, so a card's video time is atSec + (firstUtterance - anchor).
// New cards appended to the cards file stream in over SSE while you watch, so
// you can run this against a replay that is still generating.

import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, createReadStream, watch, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const val = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);

const VIDEO = val("--video", null);
const TRANSCRIPT = val("--transcript", null);
const CARDS = val("--cards", null);
const ANCHOR = val("--anchor", null);
const PORT = Number(val("--port", 8791));
const FEEDBACK = val("--feedback", "/tmp/review-feedback.jsonl");

if (!VIDEO || !TRANSCRIPT || !CARDS) {
  console.error("usage: review-server.mjs --video f.mp4 --transcript t.jsonl --cards c.jsonl [--anchor iso] [--port n]");
  process.exit(1);
}

const readJsonl = (p) =>
  existsSync(p)
    ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];

const transcript = readJsonl(TRANSCRIPT);
if (!transcript.length) { console.error("empty transcript"); process.exit(1); }
const firstUtterMs = Date.parse(transcript[0].t);
const anchorMs = ANCHOR ? Date.parse(ANCHOR) : firstUtterMs;
// Seconds of video before the first spoken word.
const OFFSET = (firstUtterMs - anchorMs) / 1000;

// Transcript as video-time captions.
const captions = transcript.map((l) => ({
  vt: (Date.parse(l.t) - anchorMs) / 1000,
  ch: l.ch,
  text: l.text,
}));

const cardToClient = (c, i) => ({
  type: "card",
  id: c.id || `c${i + 1}`,
  vt: c.atSec + OFFSET, // when it should pop, in video time
  atSec: c.atSec,
  question: c.question,
  why: c.why,
  source: c.source,
});

let cards = readJsonl(CARDS).map(cardToClient);
const clients = new Set();

// Stream new cards as the replay appends them.
const pollCards = () => {
  const fresh = readJsonl(CARDS);
  if (fresh.length > cards.length) {
    const added = fresh.slice(cards.length).map((c, i) => cardToClient(c, cards.length + i));
    cards = fresh.map(cardToClient);
    for (const c of added) {
      const payload = `data: ${JSON.stringify(c)}\n\n`;
      for (const res of clients) { try { res.write(payload); } catch {} }
    }
    console.error(`review: +${added.length} card(s), ${cards.length} total`);
  }
};
setInterval(pollCards, 2000);
if (existsSync(CARDS)) watch(CARDS, pollCards);

function serveVideo(req, res) {
  const stat = statSync(VIDEO);
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { "content-length": stat.size, "content-type": "video/mp4", "accept-ranges": "bytes" });
    createReadStream(VIDEO).pipe(res);
    return;
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const start = m[1] ? parseInt(m[1], 10) : 0;
  const end = m[2] ? parseInt(m[2], 10) : Math.min(start + 4 * 1024 * 1024, stat.size - 1);
  res.writeHead(206, {
    "content-range": `bytes ${start}-${end}/${stat.size}`,
    "accept-ranges": "bytes",
    "content-length": end - start + 1,
    "content-type": "video/mp4",
  });
  createReadStream(VIDEO, { start, end }).pipe(res);
}

createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/" ) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(join(HERE, "..", "panel", "review.html"), "utf8"));
    return;
  }
  if (url === "/video") return serveVideo(req, res);
  if (url === "/data") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ captions, cards, offset: OFFSET }));
    return;
  }
  if (url === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.method === "POST" && url === "/feedback") {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      try { appendFileSync(FEEDBACK, JSON.stringify({ ...JSON.parse(b), at: new Date().toISOString() }) + "\n"); } catch {}
      res.writeHead(204).end();
    });
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, "127.0.0.1", () => {
  console.error(`review: http://127.0.0.1:${PORT}`);
  console.error(`review: ${captions.length} utterances, ${cards.length} card(s), video offset ${OFFSET}s`);
});
