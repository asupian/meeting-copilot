#!/usr/bin/env node
// deepgram-stream.mjs <transcript.jsonl>
// Reads interleaved 2-ch 16 kHz PCM16 from stdin (ch0 = me/mic, ch1 = them/system),
// streams to Deepgram, appends final utterances to the transcript file as JSONL:
//   {"t": iso8601, "ch": "me"|"them", "speaker": int|null, "start": s, "dur": s, "text": "..."}
// No dependencies: uses Node's native WebSocket (Node 22+). Auth via websocket
// subprotocol (native WebSocket cannot set an Authorization header).

import { appendFileSync } from "node:fs";
import { execSync } from "node:child_process";

const outPath = process.argv[2];
if (!outPath) {
  console.error("usage: deepgram-stream.mjs <transcript.jsonl>");
  process.exit(1);
}

let key = process.env.DEEPGRAM_API_KEY;
if (!key) {
  try {
    key = execSync("security find-generic-password -s deepgram -w", {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
  } catch {}
}
if (!key) {
  console.error(
    "deepgram-stream: no API key. Set DEEPGRAM_API_KEY or store one with:\n" +
    "  security add-generic-password -s deepgram -a $USER -w <KEY>"
  );
  process.exit(1);
}

const params = new URLSearchParams({
  model: "nova-3",
  encoding: "linear16",
  sample_rate: "16000",
  channels: "2",
  multichannel: "true",
  diarize: "true",
  smart_format: "true",
  interim_results: "false",
  endpointing: "300",
});

const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ["token", key]);
ws.binaryType = "arraybuffer";

const CHUNK = 6400; // 100 ms of 2-ch 16 kHz PCM16
let pending = [];
let open = false;

ws.addEventListener("open", () => {
  open = true;
  console.error("deepgram-stream: connected");
  for (const b of pending) ws.send(b);
  pending = [];
});

ws.addEventListener("message", (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.type !== "Results" || !msg.is_final) return;
  const alt = msg.channel?.alternatives?.[0];
  if (!alt?.transcript) return;
  const ch = (msg.channel_index?.[0] ?? 0) === 0 ? "me" : "them";
  const line = {
    t: new Date().toISOString(),
    ch,
    speaker: alt.words?.[0]?.speaker ?? null,
    start: Math.round(msg.start * 10) / 10,
    dur: Math.round(msg.duration * 10) / 10,
    text: alt.transcript,
  };
  appendFileSync(outPath, JSON.stringify(line) + "\n");
  const who = ch === "me" ? "me" : `them:S${line.speaker ?? "?"}`;
  console.error(`[${line.start.toFixed(0).padStart(4)}s] ${who}: ${line.text}`);
});

ws.addEventListener("error", (ev) => {
  console.error("deepgram-stream: websocket error", ev.message ?? "");
});
ws.addEventListener("close", (ev) => {
  console.error(`deepgram-stream: closed (${ev.code}) ${ev.reason ?? ""}`);
  process.exit(ev.code === 1000 ? 0 : 1);
});

let buf = Buffer.alloc(0);
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= CHUNK) {
    const chunk = buf.subarray(0, CHUNK);
    buf = buf.subarray(CHUNK);
    if (open) ws.send(chunk);
    else if (pending.length < 100) pending.push(Buffer.from(chunk));
  }
});
process.stdin.on("end", () => {
  if (buf.length && open) ws.send(buf);
  if (open) ws.send(JSON.stringify({ type: "CloseStream" }));
  setTimeout(() => process.exit(0), 3000);
});
