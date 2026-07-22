# onboarding/ — get from zero to a working copilot

One guided command, under 5 minutes of attention:

```bash
copilot onboard
```

What happens, in order:

1. **Capture binaries compile in the background** — no waiting on them.
2. **The knowledge wizard** (the main event): one opening message confirms
   who you are (derived from git config) and asks where your notes live —
   an Obsidian vault (auto-detected when possible), Notion (live via
   connector, or an export), or any markdown folder — then ingests them as
   the knowledge dir. Channels (calendar, email, Slack, docs) are the LAST
   RESORT, auto-building from 30 days only when no knowledge base exists.
   Every card the copilot ever shows must cite a fact from this dir.
3. **The build tail**: signing cert, app bundles, live self-test — two Allow
   dialogs (Microphone, System Audio Recording), with you at the keyboard.
4. **A trial on YOUR material** (skippable with Enter): point it at a past
   meeting recording (Zoom/Meet export); it transcribes on-device, builds a
   pack from your fresh knowledge dir, and replays it through the brain.
   Cards cite your facts; zero cards is the tool working, not failing.
5. **Prep-ahead, on your behalf**: a pack is built for every upcoming
   calendar meeting (`prep --all`; re-runs skip what's already packed).

That's meeting-ready — at meeting time the only command is `copilot live`.

Each phase is also its own command:

```bash
./setup.sh                     # phase 1 alone: the build
copilot onboard knowledge      # phase 2 alone; re-running tops up, never restarts
copilot onboard import <dir>   # add an existing notes system (Obsidian, Notion export, any folder)
./portable/knowledge.sh init   # bare-minimum identity, no wizard (hand-written packs from there)
```

| Piece | Engine |
|---|---|
| build | [setup.sh](../setup.sh) (build, cert, TCC self-test) |
| knowledge | [portable/knowledge.sh](../portable/knowledge.sh) `setup` / `import` — format spec in [portable/KNOWLEDGE.md](../portable/KNOWLEDGE.md) |
