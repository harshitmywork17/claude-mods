# claude-mods

This repository is Harshit's single home for Claude customizations that must stay the same on every device. It is the `harshit-mods` plugin marketplace. Harshit added it to his claude.ai account, so every plugin turned on there syncs to each Claude Code session he signs in to.

Put anything he wants on all devices here as a plugin: mods (hooks modules), skills, agents, settings hooks, MCP servers, output styles. Do not put these in other repositories.

## Layout

- `.claude-plugin/marketplace.json` lists every plugin. A plugin of this repository has `"source": "./plugins/<name>"`. A third-party plugin uses its own source, as `claritymaxx` does.
- `plugins/<name>/` holds one plugin, with `.claude-plugin/plugin.json` and its components in their default folders (`skills/`, `agents/`, `hooks/`, ...).
- `README.md` has a table with one row for each plugin: its command and what it does. Keep the table current.

## Adding or changing a plugin

1. Put the plugin in `plugins/<name>/`. Its `name` must not start with `claude-`. Give it `author: { "name": "harshitmywork17" }`.
2. For a new plugin, add an entry to `marketplace.json` and a row to the README table.
3. For a changed plugin, increase `version` in its `plugin.json`, because installed copies are cached by version.
4. Run `claude plugin validate .`, then `claude plugin validate plugins/<name>`. For a mod, also run `claude plugin test plugins/<name>`. Everything must pass.
5. Commit to `main` and push. claude.ai reads the default branch.
6. Tell Harshit what changed. A new plugin is off until he turns it on in claude.ai under **Customize → Plugins**. A changed plugin arrives with the next sync, after **Check for updates** there or a new session.

## Expected sync warning

A mod that uses `$.state` names its contract in `plugin.json` as `"types": "./types/index.d.ts"`. The claude.ai sync reports `unrecognized key in plugin.json: 'types'` and removes the key from the synced copy. This is expected. The engine does not read `types` at run time: it is only for `claude plugin validate` and the editor, and the tests pass with it removed. Keep the key, because `claude plugin validate` fails without it.

## What a plugin cannot carry

Plugins do not sync `~/.claude/settings.json` (permissions, model, env), keybindings, or the status line command. Say so when one of these is asked for. Offer the closest plugin form instead, for example a mod for status line content or a settings hook for automation.
