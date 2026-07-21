export const meta = {
  name: 'brain-eval',
  description: 'Grade a brain-loop card run against the rubric (precision + recall + prescribe lenses)',
  phases: [{ title: 'Grade' }, { title: 'Synthesize' }],
}

// args: { prep, transcript, cards, rubric, context? }  (absolute file paths)
// `context` is optional free text appended to every grader prompt — use it to
// state meeting-specific caveats (e.g. no speaker attribution, date scoping).
const { prep, transcript, cards, rubric, context } = args
const EXTRA = context ? `\n\nMEETING-SPECIFIC CONTEXT (applies to every criterion):\n${context}\n` : ''

const SCORE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['falsePositives', 'misses', 'capOk', 'confidentialityOk', 'verdict', 'topFix'],
  properties: {
    falsePositives: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['card', 'ruleFailed', 'evidence'],
      properties: { card: { type: 'string' }, ruleFailed: { type: 'string' }, evidence: { type: 'string' } } } },
    misses: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['transcriptQuote', 'packFact'],
      properties: { transcriptQuote: { type: 'string' }, packFact: { type: 'string' } } } },
    capOk: { type: 'boolean' },
    confidentialityOk: { type: 'boolean' },
    verdict: { type: 'string', description: 'one line: shippable for real meetings or not, and why' },
    topFix: { type: 'string', description: 'the single highest-value fix to the contract or prep pack' },
  },
}

const lenses = [
  { key: 'precision', focus: 'Focus on FALSE POSITIVES. For every emitted card, verify C1 (source resolves in the prep pack — quote it or fail), C3 (sanctioned trigger, not generic advice), C5 (not a repeat). Be adversarial: assume each card is junk until its source line is found in the pack.' },
  { key: 'recall', focus: 'Focus on MISSES (S2). Independently read the whole transcript and prep pack. Find every moment a grounded card SHOULD have fired: a spoken claim that contradicts a specific pack number/status, or a topic squarely mapping to a pre-flagged open thread that went unraised. For each, check whether a card fired within ~90s. Self-check each miss against C1 — if you cannot write its source from the pack, it is not a miss.' },
  { key: 'prescribe', focus: 'Focus on C4 (inform, do not prescribe) and S3 (confidentiality). For every card, check it names a question / surfaces a fact and does NOT script the user’s position, pre-frame, or draft a stance without their prior words. Quote any offending phrase. Flag any card surfacing a [CONFIDENTIAL]/[SENSITIVE] pack fact.' },
]

phase('Grade')
const grades = await parallel(lenses.map(l => () => agent(
  `You are grading a live-meeting copilot's card output against a rubric.
Read all four files:
- Rubric: ${rubric}
- Prep pack (what the copilot knew): ${prep}
- Full transcript (JSONL, {t,ch,text}): ${transcript}
- Emitted cards (JSONL, one card per line with atSec): ${cards}

${l.focus}
${EXTRA}
Apply the rubric. Quote real lines as evidence (a criterion satisfied by a vibes-check is a failed criterion). Return the structured scorecard.`,
  { label: `grade:${l.key}`, phase: 'Grade', schema: SCORE_SCHEMA }
)))

phase('Synthesize')
const merged = grades.filter(Boolean)
const synthesis = await agent(
  `Three graders reviewed the same brain-loop card run through different lenses. Merge into one verdict.
Grader outputs (JSON):
${JSON.stringify(merged, null, 2)}

De-duplicate false positives and misses (same card / same transcript moment = one item). Produce the final scorecard in the rubric's mandated output format, then end with:
- VERDICT: shippable for real meetings? (yes/no + one line)
- TOP FIX: the single highest-value change to contract.md or the prep pack builder, stated as a concrete edit.`,
  { label: 'synthesize', phase: 'Synthesize' }
)

return { grades: merged, synthesis }
