These tarballs are the 0.1.7-rc.1 generation of the fork plugins (dsh-agent-teams,
dsh-context, dsh-plugin-subscriptions, dsh-plugin-aether-shell) plus their SHA256
sidecars. They are kept only as history.

The 0.2.1-rc.2 profile installs the plugins with `link:` dependencies on
fork-plugins/<name>; it does not install these tarballs. Loading one of them into a
0.2.1 Host is rejected by the plugin compatibility check (0.1.7 peer ranges), and
dsh-plugin-subscriptions cannot be installed as a tarball at all because its
`file:../releases/...` dependency and `@oven/bun-*` optional dependencies resolve
outside a profile install.

See FORK_MAINTENANCE.md, section "0.2.1-rc.2 落地记录".
