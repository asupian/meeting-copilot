import { parseFacts, match, matchWindow } from "./matcher.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Defaults to the committed rivertech fixture pack; pass a pack path to test
// against another one.
const HERE = dirname(fileURLToPath(import.meta.url));
const packPath = process.argv[2] || join(HERE, "..", "test", "fixtures", "rivertech", "prep-pack.md");
const facts = parseFacts(readFileSync(packPath, "utf8"));
console.log(`parsed ${facts.length} facts from ${packPath} (${facts.filter(f=>f.gated).length} gated, never candidates)\n`);

// NOTE: the window case needs a WINDOW — the entity is in an earlier utterance
// than the claim. An earlier version of this test doctored the claim line to
// contain the entity, which made a single-utterance matcher look like it
// worked. It did not.
const cases = [
  { name: "card 1: $35K pricing line (contradiction target)",
    want: /42,500|SOW quote/i,
    speech: "On pricing, just to confirm, the statement of work we sent over is thirty five thousand flat for the engagement." },
  { name: "card 2: overdue payment schedule (needs a window)",
    want: /payment schedule|countersign/i,
    // The entity ("payment schedule") is in the first line; the claim line
    // alone says only "that piece". Single-utterance matching cannot see it.
    window: [
      "Did we ever get the revised payment schedule over from your team?",
      "I believe that piece is outstanding on our end still, let me check after.",
    ] },
  { name: "card 3: onboarding support (reinforcement)",
    want: /onboarding/i,
    speech: "And onboarding support is included as before, right?" },
  { name: "NEGATIVE: small talk (must match nothing)",
    want: null,
    speech: "Thanks, good to see you again, how was the long weekend up at the lake?" },
  { name: "NEGATIVE: logistics (must match nothing)",
    want: null,
    speech: "Can everyone see my screen okay before we get started?" },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const hits = c.window
    ? matchWindow(c.window.map((text, i) => ({ t: new Date(Date.parse("2026-07-21T10:00:00Z") + i * 10000).toISOString(), text })), facts)
    : match(c.speech, facts);
  const matchedWanted = c.want && hits.some(h => c.want.test(h.fact.text));
  let ok;
  if (c.want === null) { ok = hits.length === 0; }
  else { ok = !!matchedWanted; }
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (hits.length === 0) console.log(`        (no candidates)`);
  for (const h of hits) console.log(`        [${h.score}] ${h.fact.text.slice(0, 78)}\n              via ${h.why.join(", ")}`);
  console.log("");
}
console.log(`${pass} pass, ${fail} fail`);
process.exitCode = fail ? 1 : 0;
