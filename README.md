# harshit-mods

A Claude Code plugin marketplace with five mods and the Claritymaxx skill.

| Plugin | Command | What it does |
|---|---|---|
| token-weather | `/weather`, `/weather hide`, `/weather show` | A band above the prompt: context fill as weather, a sparkline of the last 12 turns, growth per turn, turns left, and a `/compact` hint near the limit. |
| blast-radius | `/blast-radius`, `/blast-radius <command>` (dry run) | Catches `rm -rf`, `git reset --hard`, force pushes, `git clean -f`, `git checkout .`, `git branch -D`, `git stash drop/clear`, `DROP`/`TRUNCATE`, `mkfs`, `dd of=/dev/...`. It shows what the command would touch in a pane and forces a permission prompt. A deny from your settings is never loosened. |
| replay-theater | `/replay`, `/replay 2` | Records each turn's Edit and Write calls. In the pane, `n`/`p` step through the diffs, `o`/`w` change turn, and Esc closes it. |
| changed-files | `/changed-files` | A live sidebar of every file touched this session, with +/- counts, edit counts and a `new` tag. It opens by itself on the first edit. |
| session-meter | `/meter` | The status line shows elapsed time, tool calls and files edited. A toast appears when a turn takes 60 s or more; change it with `/plugin configure session-meter@harshit-mods`. |
| claritymaxx | `/claritymaxx:explain <topic>`, or ask "explain..." | Third-party skill from [v60samurai/claritymaxx](https://github.com/v60samurai/claritymaxx). Builds a mental model first, then explains it as text, a diagram or a small HTML page. |

## Use them on every device

Add this marketplace to your claude.ai account once:

1. On claude.ai, open **Customize**, then **Plugins**, then **Add**, then **Add marketplace**.
2. Enter `harshitmywork17/claude-mods`. If the repository is private, your GitHub account must be connected to Claude.
3. Turn on each plugin.

Plugins on your account sync to Claude Code v2.1.273 or later at session start, on every machine where you sign in with that account. Run `/reload-plugins` or start a new session to load them.

Mods run in Claude Code only: the terminal, the desktop app's Code tab, IDE extensions and cloud sessions. Claude chat on the web, desktop and mobile shows no mod UI. Claritymaxx is a skill, so it also works in Claude chat and Cowork.

## Install on one machine

```bash
claude plugin marketplace add harshitmywork17/claude-mods
claude plugin install token-weather@harshit-mods   # repeat for each plugin
```

## Develop

Each mod has tests: `claude plugin test plugins/<mod>`. Check a mod with `claude plugin validate plugins/<mod>`. Increase `version` in a mod's `plugin.json` when you change it, because installed copies are cached by version.
