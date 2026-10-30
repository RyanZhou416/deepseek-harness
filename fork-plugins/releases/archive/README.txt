These files are retired artifacts from the 0.1.7-rc.1 generation of the fork
plugins (dsh-agent-teams, dsh-context, dsh-plugin-subscriptions,
dsh-plugin-aether-shell) and from earlier @tormentalabs/claude-code-wire-compat
builds, together with their SHA256 sidecars. They are kept only as history.

The 0.2.1-rc.2 profile installs the plugins with `link:` dependencies on
`.build/fork-plugins/<name>`; it does not install these tarballs. Loading one of them
into a 0.2.1 Host is rejected by the plugin compatibility check (0.1.7 peer
ranges), and dsh-plugin-subscriptions is built from source rather than
shipped as a tarball because its `@oven/bun-*` optional dependencies resolve
outside a profile install.

The current @tormentalabs/claude-code-wire-compat source lives in
fork-plugins/claude-code-wire-compat and is compiled into the subscriptions
bundle by scripts/fork-plugins-build.ts. The current source version is
0.7.2-dsh16 and has no tarball. The 0.7.2-dsh14 and 0.7.2-dsh15 tarballs in
fork-plugins/releases/ are kept for history only; no build reads or installs
them.

See FORK_MAINTENANCE.md, section "0.2.1-rc.2 落地记录", and
fork-plugins/releases/README.md.
