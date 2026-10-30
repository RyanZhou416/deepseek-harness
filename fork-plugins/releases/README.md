# Fork plugin release artifacts

This directory keeps built plugin tarballs and their SHA-256 sidecars. A
current `web` profile does not install them: `build.cmd` builds the fork
plugins from source and links the staged packages, so a clean checkout needs
no hand-supplied tarball.

## Current generation

| Artifact | Role |
| --- | --- |
| `ryanzhou416-dsh-plugin-aether-shell-0.1.0-dsh021rc2.*.tgz` | Previous AetherShell artifacts, kept for history and rollback inspection. `build.cmd` now compiles the plugin from `fork-plugins/dsh-plugin-aether-shell`. |
| `tormentalabs-claude-code-wire-compat-0.7.2-dsh14.tgz` | Earlier wire-builder artifact, history only. |
| `tormentalabs-claude-code-wire-compat-0.7.2-dsh15.tgz` | The wire builder that first preserved `clear_at`; retained as history and rollback evidence only. No build reads or installs it. |

`dsh-plugin-subscriptions` has no tarball in this generation; it is staged
from source.

## Claude wire compat

`@tormentalabs/claude-code-wire-compat` source lives in
`fork-plugins/claude-code-wire-compat`. It needs no tarball release:

- `packages`-style consumers use the local source package directly
  (`file:../claude-code-wire-compat`), and its `prepare` script builds
  `dist/`.
- `scripts/fork-plugins-build.ts` compiles its `dist/` from source with the
  repository TypeScript compiler and inlines it into the subscriptions
  bundle, so the installed profile resolves no compat dependency.
- The `0.7.2-dsh15` tarball stays here only because released artifacts are
  never deleted; it is not a build input. See
  `fork-plugins/claude-code-wire-compat/FORK_MAINTENANCE.md`.

## Retired artifacts

`archive/` holds the retired 0.1.7-rc.1-generation plugin tarballs and older
wire-builder builds. They are history only; see `archive/README.txt`. Never
install them into a current profile and never repack or delete a released
tarball to make room.
