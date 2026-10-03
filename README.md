# harshit-mods

A Claude Code plugin marketplace, and the single home for Claude customizations that stay the same on every device: nine mods, the Claritymaxx skill, the sync-home skill, and the karpathy-guidelines and python-standards coding skills. To add something, ask Claude to put it "on all my devices". The sync-home skill and `CLAUDE.md` tell it how.

| Plugin | Command | What it does |
|---|---|---|
| token-weather | `/weather`, `/weather hide`, `/weather show` | A band above the prompt: context fill as weather, a sparkline of the last 12 turns, growth per turn, turns left, and a `/compact` hint near the limit. |
| blast-radius | `/blast-radius`, `/blast-radius <command>` (dry run) | Catches `rm -rf`, `git reset --hard`, force pushes, `git clean -f`, `git checkout .`, `git branch -D`, `git stash drop/clear`, `DROP`/`TRUNCATE`, `mkfs`, `dd of=/dev/...`. It shows what the command would touch in a pane and forces a permission prompt. A deny from your settings is never loosened. |
| replay-theater | `/replay`, `/replay 2` | Records each turn's Edit and Write calls. In the pane, `n`/`p` step through the diffs, `o`/`w` change turn, and Esc closes it. |
| changed-files | `/changed-files` | A live sidebar of every file touched this session, with +/- counts, edit counts and a `new` tag. It opens by itself on the first edit. |
| session-meter | `/meter` | The status line shows elapsed time, tool calls and files edited. A toast appears when a turn takes 60 s or more; change it with `/plugin configure session-meter@harshit-mods`. |
| claritymaxx | `/claritymaxx:explain <topic>`, or ask "explain..." | Third-party skill from [v60samurai/claritymaxx](https://github.com/v60samurai/claritymaxx). Builds a mental model first, then explains it as text, a diagram or a small HTML page. |
| fork-explorer | `/fork <what if...>`, or type in the pane | Runs a side question over the current session and shows 2-3 alternative approaches as cards side by side, with pros, cons and effort. "use this" puts the choice in your prompt box to edit and send. Nothing is added to your conversation. |
| mission-control | `/mission` | A live pane of what Claude is executing: each tool call with its input, status badge (✓ ✗ ⊘ ●), duration and output; subagents in their own lanes with tool and token counts; a network-tab style waterfall; time spent in the model between tools. `v` switches between the timeline and the outputs. Observe-only; it never changes a call. |
| diff-minimap | automatic | A thin strip beside each Edit and Write row in the transcript. Green, red and yellow ticks show where in the file the change sits, with the line range and the file length. |
| codebase-atlas | `/atlas`, `/atlas changes`, `/atlas components <file>`, `/atlas calls <name>`, `/atlas decisions`, `/atlas rescan` | One pane with six tabs. **Map**: folders as boxes in dependency layers (entry points on top, foundations at the bottom), lit yellow when Claude edits and cyan when it reads; select one for what it imports and what uses it. **Changes**: every uncommitted change mapped to the functions and classes it added, modified or removed, with call-site counts, the layers crossed and the files that import what changed. **Components**: a file's classes, functions and methods with size bars, what each calls, and which changed. **Calls**: callers and callees of any function; type a name or select one in the transcript, then walk the graph. **Decisions**: a timeline of decisions a small model pulls from each turn (turn off with `extractDecisions`). **Explain**: side-question explanations of a folder, a function or the session's changes that never enter your conversation. Works with or without git: in a git repo, changes are measured against the last commit; in a plain folder, against the files as Atlas first read them that session (dependencies, virtual environments and build output are skipped). Reads Python and JS/TS. |
| sync-home | (automatic) or ask "add X to all my devices" | A skill that tells Claude this repository is where plugins, mods, skills and other customizations go so they sync to every device. Claude adds them under `plugins/`, validates, pushes and tells you what to turn on. |
| karpathy-guidelines | `/karpathy-guidelines:clean-code`, or automatic on any coding task | Guidelines from Andrej Karpathy's notes on LLM coding mistakes: think before coding, simplicity first, surgical changes, goal-driven execution, with worked examples in `EXAMPLES.md`. |
| python-standards | `/python-standards:python-standards`, or automatic on Python work | Python standards: SOLID, DRY, KISS and YAGNI; FastAPI project layout; naming; OWASP-aligned secure coding; linting and testing setup. |

## Use them on every device

Add this marketplace to your claude.ai account once:

1. On claude.ai, open **Customize**, then **Plugins**, then **Add**, then **Add marketplace**.
2. Enter `harshitmywork17/claude-mods`. If the repository is private, your GitHub account must be connected to Claude.
3. Turn on each plugin. Turn on `sync-home` too, so every session knows to put new synced customizations here.

Plugins on your account sync to Claude Code v2.1.273 or later at session start, on every machine where you sign in with that account. Run `/reload-plugins` or start a new session to load them.

Mods run in Claude Code only: the terminal, the desktop app's Code tab, IDE extensions and cloud sessions. Claude chat on the web, desktop and mobile shows no mod UI. Claritymaxx is a skill, so it also works in Claude chat and Cowork.

## Install on one machine

```bash
claude plugin marketplace add harshitmywork17/claude-mods
claude plugin install token-weather@harshit-mods   # repeat for each plugin
```

## Develop

Each mod has tests: `claude plugin test plugins/<mod>`. Check a mod with `claude plugin validate plugins/<mod>`. Increase `version` in a mod's `plugin.json` when you change it, because installed copies are cached by version.
