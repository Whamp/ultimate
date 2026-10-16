# Shared skills (optional)

Adds `~/.agents/skills` to the agent's `skills` system prompt section. This folder is
an optional distribution artifact, not an active project extension. Nothing is
loaded until you install it.

## Install and control

From the Ultimate repository root, copy the facet and this README to your user
extensions directory (review any existing destination files before replacing them):

```sh
mkdir -p ~/.ultimate/extensions/shared-skills
cp .ultimate/optional-extensions/shared-skills/{server.ts,README.md} \
  ~/.ultimate/extensions/shared-skills/
```

Ultimate discovers user extensions automatically. No restart or core configuration
change is required. To turn it off, add `shared-skills` to `extensions.disable` in
`~/.ultimate/settings.json`. To turn it back on, remove that entry, or use
`extensions.enable` in the applicable settings layer. Project settings can override
user settings. Removing the installed folder also removes its contribution.

## Behavior and limits

- Reads skills from `~/.agents/skills` for each request; edits are available on the
  next request. No skills, symlinks, paths, or settings are created or changed.
- Uses Pi's skill loader and prompt formatter. Descriptions and absolute `SKILL.md`
  paths appear in the prompt, not the full skill bodies. Pi's discovery, ignore,
  validation, and `disable-model-invocation: true` rules remain in effect. User-only
  skills are not advertised. This extension adds no explicit-invocation command.
- Existing host skills win same-name conflicts, including user-only skills. The
  existing built-in, Pi, user, and project precedence is not changed. The effective
  request working directory is forwarded to the host's skill loader.
- A missing shared directory is harmless and produces no notice. Other loader
  diagnostics are reported through extension notices; an unchanged diagnostic is
  not repeated on consecutive renders. Pi can load a skill with validation warnings
  but omits a skill with no description.
- Acts only on the existing `skills` prompt section. It does not change core skill
  discovery or the native Info panel's skills inventory. That inventory remains
  core-only, so it will not list skills contributed only by this extension.

Shared skills can increase prompt size and contain instructions. Review them before
installation. Disabling or removing this extension restores the host's skills prompt
without changing the skills on disk.
