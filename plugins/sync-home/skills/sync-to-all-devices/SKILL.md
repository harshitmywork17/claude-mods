---
name: sync-to-all-devices
description: Use when Harshit wants a Claude customization available on all his devices or kept in sync across machines, or asks to create, add, install, save or update a plugin, mod, skill, agent, hook, MCP server or output style "for everywhere", "on all devices", "synced" or "in my mods repo". Also use when he says to put something in claude-mods or the harshit-mods marketplace.
---

# Sync to all devices

Harshit keeps every Claude customization that must be the same on all his devices in one repository: `harshitmywork17/claude-mods`. It is the `harshit-mods` plugin marketplace, and his claude.ai account syncs its plugins to every Claude Code session he signs in to. Put the work there, never in the project repository he is working in.

1. Get the repository. In a cloud session, attach it with the `add_repo` tool (owner `harshitmywork17`, repo `claude-mods`, access `push`), then clone it. On a local machine, clone `https://github.com/harshitmywork17/claude-mods`, or use an existing clone.
2. Read its `CLAUDE.md` and follow it: the layout, the marketplace entry, the README table, the version bump, validation and tests, and a push to `main`.
3. Build the customization as a plugin under `plugins/<name>/`. For a mod (a hooks module with panes, bands, a status line, toasts or tool guards), load the `plugin-authoring` skill first if it is available.
4. When it is pushed, tell Harshit the plugin's name and its command. A new plugin is off until he turns it on in claude.ai under **Customize → Plugins**. A changed plugin arrives with the next sync.

Plugins cannot sync `~/.claude/settings.json` (permissions, model, env), keybindings, or the status line command. If one of these is asked for, say so and offer the closest plugin form.
