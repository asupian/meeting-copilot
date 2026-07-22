# onboarding/ — get from zero to a working copilot

One command per step, in order:

```bash
copilot onboard                # install: OS gate, build, signing cert, permissions
copilot onboard demo           # see it work first — replay a fixture, no permissions, no mic
copilot onboard knowledge      # build what the copilot knows (guided wizard, ~10-15 min)
copilot onboard import <dir>   # or distill an existing notes system (Obsidian, Notion export, any folder)
```

This directory holds only the journey script ([onboard.sh](onboard.sh)); the
engines live elsewhere and are usable directly:

| Step | Engine |
|---|---|
| install | [setup.sh](../setup.sh) (build, cert, TCC self-test) |
| demo | [brain/brain-loop.mjs](../brain/brain-loop.mjs) replaying [test/fixtures/rivertech/](../test/fixtures/rivertech/) |
| knowledge | [portable/knowledge.sh](../portable/knowledge.sh) `setup` / `import` — format spec in [portable/KNOWLEDGE.md](../portable/KNOWLEDGE.md) |

The demo is the product in miniature: one grounded card citing the $42,500
SOW fact, a second card suppressed, silence otherwise. If that behavior
surprises you, read the Principles section of the [root README](../README.md)
before building a knowledge dir.
