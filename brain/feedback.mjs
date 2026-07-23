// The card-feedback lifecycle in one place: votes in, tighten-only signals
// out, cross-meeting memory on disk. Feedback can only make the copilot
// QUIETER — gap() widens the card spacing, block() raises the prompt bar —
// and with zero votes and no history both are exact no-ops, which is what
// keeps a feedback-free run (the replay gate included) byte-identical.

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

export function makeFeedback({ userName, logPath, historyPath }) {
  const cardMeta = new Map();   // id -> {question, type}
  const votes = new Map();      // cardId -> {vote, atMs}; latest vote per card wins

  // Negative votes from PAST meetings (30-day window, last 10): they seed the
  // prompt's bar from check one, but never touch the mechanical gap — history
  // makes the copilot choosier, not mute. Missing/empty file -> [] -> no-op.
  const pastNegatives = (() => {
    try {
      const cutoff = Date.now() - 30 * 86_400_000;
      return readFileSync(historyPath, "utf8").split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e) => e && (e.vote === "down" || e.vote === "dismiss") && e.question && Date.parse(e.at) > cutoff)
        .slice(-10);
    } catch { return []; }
  })();

  function noteCard(id, question, type) { cardMeta.set(id, { question, type }); }

  // Validate + record one vote. Everything valid lands in the audit log; only
  // cards THIS session surfaced modulate behavior (a stale id from a reloaded
  // panel is logged, not consumed). Returns null for invalid payloads.
  function vote(fb) {
    if (typeof fb?.cardId !== "string" || !["up", "down", "dismiss"].includes(fb.vote)) return null;
    try { appendFileSync(logPath, JSON.stringify({ ...fb, at: new Date().toISOString() }) + "\n"); } catch {}
    const known = cardMeta.has(fb.cardId);
    if (known) votes.set(fb.cardId, { vote: fb.vote, atMs: Date.now() });
    return { known };
  }

  function gap() {
    // Extra seconds of min-gap from recent negative votes. Upvotes only offset
    // negatives; they never lower the gap below --min-gap and never touch --cap.
    const now = Date.now();
    let net = 0;
    for (const { vote: v, atMs } of votes.values()) {
      if (now - atMs > 10 * 60_000) continue;              // 10-min recency window
      net += v === "down" ? 1 : v === "dismiss" ? 0.5 : -1;
    }
    return net >= 4 ? 180 : net >= 2 ? 90 : 0;
  }

  function block() {
    // Conditional block, not a contract line: same reasoning as asrCaveat — a
    // rule that only appears when relevant stays salient. Quotes only questions
    // the model itself wrote (newline-stripped, capped), so no user free text
    // reaches the prompt.
    if (!votes.size && !pastNegatives.length) return "";
    const clip = (s) => String(s).replace(/\s+/g, " ").slice(0, 120);
    const q = (id) => clip(cardMeta.get(id)?.question || "");
    const listOf = (v) => [...votes].filter(([, x]) => x.vote === v).map(([id]) => `- "${q(id)}"`);
    const down = listOf("down").slice(-5), dis = listOf("dismiss").slice(-5), up = listOf("up").slice(-3);
    const past = pastNegatives.map((e) => `- "${clip(e.question)}"`);
    return [
      `FEEDBACK ON EARLIER CARDS (${userName}'s votes on cards from this and past meetings):`,
      ...(down.length ? [`Downvoted — not worth the interruption:`, ...down] : []),
      ...(dis.length ? [`Dismissed (weak negative):`, ...dis] : []),
      ...(up.length ? [`Upvoted — the bar was right here:`, ...up] : []),
      ...(past.length ? [`Downvoted or dismissed in PAST meetings (recent):`, ...past] : []),
      `Read this as one-directional calibration of your bar: a new candidate that`,
      `resembles a downvoted or dismissed card (same fact, same angle, same kind of`,
      `trigger) must clear a HIGHER bar — surface it only if clearly stronger (a`,
      `harder trigger, a fresher fact, a live collision); when in doubt, stay silent.`,
      `Upvotes are NOT a request for more cards or looser grounding. Feedback never`,
      `lowers the bar: every card still cites a held fact, and silence stays correct.`,
    ].join("\n");
  }

  // Persist this session's votes so the next meeting starts with the bar
  // already calibrated. Capped so the file can't grow into a shadow archive.
  function persist(title) {
    if (!votes.size) return 0;
    try {
      const at = new Date().toISOString();
      const lines = [...votes].map(([id, v]) =>
        JSON.stringify({ at, title, vote: v.vote,
                         question: cardMeta.get(id)?.question || "", type: cardMeta.get(id)?.type }));
      appendFileSync(historyPath, lines.join("\n") + "\n");
      const all = readFileSync(historyPath, "utf8").split("\n").filter(Boolean);
      if (all.length > 200) writeFileSync(historyPath, all.slice(-200).join("\n") + "\n");
      return lines.length;
    } catch { return 0; }
  }

  return { noteCard, vote, gap, block, persist, seeded: pastNegatives.length };
}
