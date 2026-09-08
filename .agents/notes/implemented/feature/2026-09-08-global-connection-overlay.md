# Agent Note: Global Web connection recovery overlay

Status: implemented

English | [中文](2026-09-08-global-connection-overlay.zh.md)

## Problem

The Settings control presents connection loss and recovery, but collapsing the sidebar or closing Settings can hide that control while the browser remains disconnected. A user needs one recovery action that stays visible across the Web shell without giving the Client authority to restart the Host.

## Decision

`dsh-client-ui-settings-general` registers `ConnectionOverlay` in `shell.overlay`. It reads the official `ctx.connection.state`, calls `ctx.connection.reconnect()`, and uses the shared localized `ConnectionIndicator`; healthy startup renders nothing, disconnected and connecting states stay actionable, and a recovered state remains visible for two seconds.

The overlay is independent of the sidebar and Settings modal. It controls only the browser's Gateway connection and never starts, supervises, or silently restarts the Host.

## Alternatives considered

**Keep recovery only beside Settings.** Rejected because the control disappears with the collapsed sidebar even though the outage still blocks the complete application.

**Restart the Host automatically from the Client.** Rejected because a browser connection cannot distinguish a stopped Host from startup, maintenance, policy shutdown, or an external failure, and it owns no process authority.

**Show a permanent healthy indicator.** Rejected because uninterrupted operation needs no action; the two-second recovered state confirms the transition without retaining idle chrome.

## Consequences

Connection loss remains visible and recoverable from every shell layout, with the same localized labels and retry operation as the inline Settings control. The shell carries one additional overlay registration and one recovery timer, while Host recovery remains an explicit operator action.
