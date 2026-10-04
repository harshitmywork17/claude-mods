# harshit-mods

A Claude Code plugin marketplace, and the single home for Claude customizations that stay the same on every device: ten mods, the Claritymaxx skill, the sync-home skill, and the karpathy-guidelines and python-standards coding skills. To add something, ask Claude to put it "on all my devices". The sync-home skill and `CLAUDE.md` tell it how.

| Plugin | Command | What it does |
|---|---|---|
| usage-forecast | `/forecast`, `/forecast hide`, `/forecast show` | A band above the prompt. **5-hour** and **Weekly** plan limits as coloured bars (green, then yellow from 70%, red from 90%) with the percent used, a reset countdown and the reset time (`↻ resets in 1h 12m · 15:40`), and `⚠ at this pace, out in 40m` when you would run out before the reset. Below it, the context window as weather with a 12-turn sparkline and turns left. Replaces token-weather. |
| blast-radius | `/blast-radius`, `/blast-radius <command>` (dry run) | Catches `rm -rf`, `git reset --hard`, force pushes, `git clean -f`, `git checkout .`, `git branch -D`, `git stash drop/clear`, `DROP`/`TRUNCATE`, `mkfs`, `dd of=/dev/...`. It shows what the command would touch in a pane and forces a permission prompt. A deny from your settings is never loosened. |
| replay-theater | `/replay`, `/replay 2` | Records each turn's Edit and Write calls. In the pane, `n`/`p` step through the diffs, `o`/`w` change turn, and Esc closes it. |
| changed-files | `/changed-files` | A live sidebar of every file touched this session, with +/- counts, edit counts and a `new` tag. It opens by itself on the first edit. |
| session-meter | `/meter` | The status line shows elapsed time, tool calls and files edited. A toast appears when a turn takes 60 s or more; change it with `/plugin configure session-meter@harshit-mods`. |
| claritymaxx | `/claritymaxx:explain <topic>`, or ask "explain..." | Third-party skill from [v60samurai/claritymaxx](https://github.com/v60samurai/claritymaxx). Builds a mental model first, then explains it as text, a diagram or a small HTML page. |
| fork-explorer | `/fork <what if...>`, or type in the pane | Runs a side question over the current session and shows 2-3 alternative approaches as cards side by side, with pros, cons and effort. "use this" puts the choice in your prompt box to edit and send. Nothing is added to your conversation. |
| mission-control | `/mission` | A live pane of what Claude is executing: each tool call with its input, status badge (✓ ✗ ⊘ ●), duration and output; subagents in their own lanes with tool and token counts; a network-tab style waterfall; time spent in the model between tools. `v` switches between the timeline and the outputs. Observe-only; it never changes a call. |
| diff-minimap | automatic | A thin strip beside each Edit and Write row in the transcript. Green, red and yellow ticks show where in the file the change sits, with the line range and the file length. |
| codebase-atlas | `/atlas`, `/atlas changes`, `/atlas components <file>`, `/atlas calls <name>`, `/atlas decisions`, `/atlas rescan` | One pane with six tabs. **Map**: folders as boxes in dependency layers (entry points on top, foundations at the bottom), lit yellow when Claude edits and cyan when it reads; select one for what it imports and what uses it. **Changes**: every uncommitted change mapped to the functions and classes it added, modified or removed, with call-site counts, the layers crossed and the files that import what changed. **Components**: a file's classes, functions and methods with size bars, what each calls, and which changed. **Calls**: callers and callees of any function; type a name or select one in the transcript, then walk the graph. **Decisions**: a timeline of decisions a small model pulls from each turn (turn off with `extractDecisions`). **Explain**: side-question explanations of a folder, a function or the session's changes that never enter your conversation. Works with or without git: in a git repo, changes are measured against the last commit; in a plain folder, against the files as Atlas first read them that session (dependencies, virtual environments and build output are skipped). Reads Python and JS/TS. |
| workbench | `/wb`, `/wb changes [file]`, `/wb preview <file>`, `/wb artifacts`, `/wb map`, `/wb usage`, `/wb calls <name>`, `/wb forecast`, `/wb workbench`, `/wb hud off` | One workspace. A one-line **band** above the prompt with two slides, switched with ◀ ▶: **Workbench** (session time, tool calls, files changed with +/−, new files, plan limits and context on wide terminals, then the running tool or the last edit and its functions) and **Forecast** (5-hour and weekly limits with bars, reset times and pace, plus the context forecast; it shows the usage-forecast mod's band when that mod is on). A **pane** with six tabs on one row: **Now**, the turn's tool calls with status and timing, failures with their error, and subagents nested under the call that started them; **Changes**, every file with a change bar and the functions it touched, then a file's changed functions and highlighted diff since Claude first touched it, then each edit (replay with n/p); **Preview**, a live render of the file being edited (Markdown, CSV table, JSON tree, HTML screenshot, PNG, code) with recent files one press away; **Artifacts**, files created this session by Claude ✦ or its commands, with preview and copy path; **Map**, architecture layers with folder sizes and imports, a file's components, and the call graph; **Usage**, limits with reset times and pace, context, and cost per turn. Works with or without git. Claude Code's own diff panel sits above mod panes: run `/diff` to hide it if it covers the workbench. |
| crew | `/crew`, `/crew auto off`, `/crew close` | An **Agents** side pane, like a mission board for subagents. Three cards on top total the session's cost, tokens and time. Each subagent is a little pixel crew member whose hat shows its effort (heavy, careful, medium, light), with its model and effort level, context used with a bar, tokens, its share of the cost and how long it ran; it walks while it works and shows the tool it is running. Sections: **Running**, **Completed** (✓ done, ✗ failed, ⊘ stopped; folds) and **Planned**, the tasks from Claude's task or todo list with what each still waits for ("after 1, 3"). Click an agent for its task, tool count and answer. Opens by itself when the first subagent starts; `/crew auto off` stops that. |
| explainer-page | `/explainer-page:explainer-page`, or ask for a visual or interactive explainer page | A skill for textbook-style HTML pages that teach one concept: each idea in words, maths, a figure and code, with colour-coded notation (inputs blue, outputs orange, parameters green, functions violet, probabilities pink) kept identical everywhere; tables and figures (3D bars, node diagrams) drawn from one data source and highlighted together on hover; sliders where a parameter is the point; code cells with their real output; margin notes, callouts and check-yourself questions; light and dark themes and a contents sidebar. Publishes as a claude.ai artifact when that tool is available, otherwise writes an .html file. Triggers only on an explicit request for such a page. |
| savvy-flow | `/savvy-flow:savvy-flow <task>` | A copy of savvy-flow from [johnnyvizz/claude-kit](https://github.com/johnnyvizz/claude-kit) with one change: the top tier, `savvy-fable`, runs on Opus at max effort instead of the Fable model, so it works without Fable access. The session model plans the task, delegates pieces to five tiered worker agents (`savvy-fable`, `savvy-heavy`, `savvy-careful`, `savvy-medium`, `savvy-light`) and reviews what they return. `tools/sync-savvy-flow.sh` refreshes the copy from upstream and reapplies the change; the **Sync savvy-flow** GitHub Action runs it daily and commits when upstream changed. |
| savvy-progress | `/agents-info` | From the same repo, following its main branch the same way. A progress bar above the prompt driven by savvy-flow, and an agents panel with model, effort, step progress, context, estimated cost and time. Animated crabs draw in the desktop app; the terminal shows text rows (crew draws its sprites in both). |
| sync-home | (automatic) or ask "add X to all my devices" | A skill that tells Claude this repository is where plugins, mods, skills and other customizations go so they sync to every device. Claude adds them under `plugins/`, validates, pushes and tells you what to turn on. |
| karpathy-guidelines | `/karpathy-guidelines:clean-code`, or automatic on any coding task | Guidelines from Andrej Karpathy's notes on LLM coding mistakes: think before coding, simplicity first, surgical changes, goal-driven execution, with worked examples in `EXAMPLES.md`. |
| python-standards | `/python-standards:python-standards`, or automatic on Python work | Python standards: SOLID, DRY, KISS and YAGNI; FastAPI project layout; naming; OWASP-aligned secure coding; linting and testing setup. |

## Use them on every device

Add this marketplace to your claude.ai account once:

1. On claude.ai, open **Customize**, then **Plugins**, then **Add**, then **Add marketplace**.
2. Enter `harshitmywork17/claude-mods`. If the repository is private, your GitHub account must be connected to Claude.
3. Turn on each plugin. Turn on `sync-home` too, so every session knows to put new synced customizations here.

Plugins on your account sync at session start, on every machine where you sign in to Claude Code with that account. Mods need Claude Code v2.1.287 or later (`claude --version`, then `claude update`). After you push a change here, press **Check for updates** on the marketplace in claude.ai, and turn on any new plugin. Then start a new session.

If a command such as `/wb` is missing on a machine:

1. `claude --version` must be 2.1.287 or later.
2. `claude plugin list` should show `workbench@synced`. If it doesn't, the sync hasn't picked it up: check for updates in claude.ai, or install on that machine as below.
3. `claude plugin test` run in an empty folder should say `no hooks module to load`. Any other message means mods are turned off there.

Mods run in Claude Code only: the terminal, the desktop app's Code tab, IDE extensions and cloud sessions set up as below. Claude chat on the web, desktop and mobile shows no mod UI. Claritymaxx is a skill, so it also works in Claude chat and Cowork.

## Use them in cloud sessions

Cloud sessions at claude.ai/code don't load account plugins or the plugins a repository lists in `.claude/settings.json`. They do load plugin folders named in `CLAUDE_CODE_PLUGIN_DIRS`. Set it once on the cloud environment:

1. Open the environment menu in a session's title bar, then **Edit**.
2. Under **Environment variables**, add:
   ```
   CLAUDE_CODE_PLUGIN_DIRS=/home/user/claude-mods/plugins
   ```
3. When you start a cloud session, select `harshitmywork17/claude-mods` alongside the repository you're working on. It is cloned to `/home/user/claude-mods`, and every plugin in `plugins/` loads, including new ones.

A cloud session can only clone the repositories selected for it, because this repository is private. In a session without it, the variable points at a missing folder, which Claude Code skips.

## Install on one machine

```bash
claude plugin marketplace add harshitmywork17/claude-mods
claude plugin install workbench@harshit-mods   # repeat for each plugin
```

Or run every plugin from a local clone, picking up changes with `git pull`: add `"env": { "CLAUDE_CODE_PLUGIN_DIRS": "<path to clone>/plugins" }` to `~/.claude/settings.json`. Don't combine this with account sync on the same machine: when two copies share a name, only the first one loads.

## Develop

Each mod has tests: `claude plugin test plugins/<mod>`. Check a mod with `claude plugin validate plugins/<mod>`. Increase `version` in a mod's `plugin.json` when you change it, because installed copies are cached by version.
