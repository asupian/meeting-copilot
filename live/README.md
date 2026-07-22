# live/ — run the copilot in the meeting

```bash
copilot live              # pack picked by start time; capture + brain + panel; Ctrl-C = digest
copilot live vendor       # pack picked by name (filename substring)
copilot live --prep <f>   # explicit pack; all other flags pass through to start.sh
copilot live capture      # capture only (transcript + screen OCR, no brain)
copilot live selftest     # verify the system-audio tap
```

This directory holds only the journey script ([live.sh](live.sh)), which
resolves WHICH pack the meeting gets (`--prep` > name > start-time match >
legacy `prep-pack.md`) and hands off to [start.sh](../start.sh) — the engine
that runs [capture/](../capture/) (on-device transcription + window OCR),
[brain/](../brain/) (one grounded card at a time), and [panel/](../panel/)
(the floating UI).

What it does live (principles 2 and 3): detects contradictions with held
facts, risks and goal drift the room is glossing past, and wins worth naming;
keeps no recording (audio and pixels become text signals on-device; the text
transcript stays in a local session folder). Card feedback (👍/👎/dismiss) is
consumed in one direction only — it can make the copilot quieter, never
chattier (HOW-IT-WORKS, "The feedback loop").
