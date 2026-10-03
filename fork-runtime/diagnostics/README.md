# Windows memory diagnostics

English | [中文](README.zh.md)

## Summary

The fork's `run.cmd` records memory evidence automatically through the [profile overlay](cordis.patch.yml). Each Host writes a private `DSH_DIAGNOSTICS/memory-runs/run-*` directory. The recorder uses an internal Inspector session and opens no debugging port. Session files and settings are unchanged.

## Configuration

Edit the overlay's complete `config` mapping before starting `run.cmd`. Set `snapshots: false` to keep sampling without full snapshots. The normal sample interval is 30 seconds. Live-allocation profiles use a 1 MiB sampling interval and are saved every two minutes; four files of at most 32 MiB rotate. Event logs rotate across four 16 MiB files per run. These are per-run limits; old run directories are not automatically deleted. Legacy watchdog and ownership logs have their own configuration.

Full snapshots pause the Host and temporarily increase memory use. The recorder attempts at most two per activation: a baseline after 30 seconds and a growth snapshot after 768 MiB of heap growth, or after a tracked disposed object survives two observed major GCs for at least 60 seconds. A capture requires heap used at most 1.5 GiB, heap total at most 2 GiB, and both free RAM and free disk of at least four times heap total plus 2 GiB. Admission also checks an 8 GiB snapshot budget across this recorder's run directories. This budget uses the same reserve estimate; it is not a hard limit on V8's actual snapshot size or pause duration. Skipped captures record the reason. Failed captures consume an attempt.

## Evidence and interpretation

`manifest.json` records Node and platform, configuration, revision, dirty-file count, recorder hashes and available local profile/plugin fingerprints. `events.ndjson` contains memory, major/minor GC totals, event-loop delay, active resource counts and bounded Agent/Session lifetime observations. Tracking IDs are anonymous. Tracking uses weak references; samples retain only scalar metadata. At most 10,000 objects and 64 oldest disposed-object details are tracked. `droppedTracking` means counts are incomplete. Active Session event counts and event counts at disposal describe workload, not retained bytes; Agent and Session counts overlap.

Open `allocations-*.heapprofile` and available `baseline.heapsnapshot` / `growth.heapsnapshot` with Chrome DevTools' Memory panel. Compare surviving allocations and strong retaining paths, then correlate the snapshot's weak tracking records with lifetime IDs and GC ages. Profiling shows sampled allocation stacks; a heap snapshot supplies the retaining graph. Sampling metadata and JSON serialization have overhead beyond the output file limit. Weak observations and profile stacks alone cannot identify every owner. Leaks beginning after the early snapshot window may require a focused reproduction.

For snapshots too large for DevTools, `node retainers.mjs <file.heapsnapshot> --class ReactLoopAgent` (or `--id N`, `--max-groups N`, `--json`) prints grouped shortest strong retainer chains offline. It never follows weak edges and admits a WeakMap value only when both key and table are reachable, so a selected object absent from every chain is collectable. The Web `agent-lifetime` stress scenario uses the same module through `retainers.d.mts` types.

Snapshots and profiles can contain private runtime content and paths. Keep them local and never commit them. Removing a raw snapshot permanently removes its full retaining graph; keep reports and a deletion manifest when cleaning old evidence. The recorder never restarts the Host.

## Verification

Run `pnpm exec vitest run scripts/fork-memory-lifetime.spec.ts scripts/fork-memory-recorder.spec.ts scripts/fork-windows-launchers.spec.ts`. The tests exercise real GC and internal Inspector sampling in fresh child processes, resource guards, the two-capture limit, lifetime-triggered capture, teardown races and Windows launch argument forwarding. Full snapshot limits use synthetic fixtures. Deployment validation also requires a supported `dsh web` launch in a private home with a random port and graceful exit; a configuration dump alone does not verify plugin activation.
