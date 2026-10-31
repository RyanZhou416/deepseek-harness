# Agent Note: 用载体写出进度保活拥塞的 Remote 流 socket

Status: implemented

[English](2026-10-31-remote-stream-heartbeat-write-progress.md) | 中文

## 问题

`session.follow` 的首帧 12.8 MB（另一会话观测到 44 MB），在 10 Mbps / 120 ms 链路上需要数十秒。两秒一次的心跳把 Ping 控制帧排在该数据帧之后，浏览器要等整个帧重组完成才能回复 Pong，于是连续两次未清零在 4–6 秒时终止了 socket。浏览器报告关闭码 1006，重连后重新请求同一首帧，循环往复。把 `websocketHeartbeatIntervalMs` 调到 120000 后两帧都完整到达且无断开，但它同样会把真正掉线对端的发现时间推迟 120 秒。

## 决策

每个心跳 tick 采样升级 socket 的累计 `bytesWritten` 与 `writableLength`，以及 ws 的 `bufferedAmount`。若连接在上一 tick 仍有下行字节待写，且此后载体接受的字节多于自身两字节的空 Ping 帧，则该连接视为存活并清零未命中计数。载体是 HTTP 服务器交给 `handleUpgrade` 的 `Duplex`，因此服务端不读取 ws 私有 `_socket`；只有 `net.Socket`（含 `TLSSocket`）报告 `bytesWritten`，不报告它的载体仍只按 Pong 与入站帧判断。上一 tick 必须有待写数据，因此已排空的 socket 仍需 Pong 或入站帧；写出停滞的帧或停止读取的对端不会带来 `bytesWritten` 增长，仍会在两次未命中后终止。压缩不会削弱该信号：ws 先完成压缩再写入载体，异步 zlib 运行期间 `bufferedAmount` 可能为零，因此它只作为判断是否有待写字节的补充。

## 备选方案

**调大心跳间隔。** 这只是掩盖缺陷：掉线连接与停滞帧的发现时间都随间隔等比推迟，而一个有界的大帧仍需要大于其传输时间的间隔。实测的 120000 ms 是证据，不是修复。

**把任何 `bytesWritten` 增长都算作存活。** 服务端自己的 Ping 帧每个间隔就让它增长两个字节，无响应对端会永远显得存活。要求上一 tick 有待写数据且增长超过 Ping 帧，Ping 就无法自证存活。

**只依赖 `bufferedAmount` 或现有活动检查所用的 `send()` 完成回调。** 完成回调只在内核接受完全部字节后才到达，在拥塞链路上这正是要等待的延迟；异步压缩期间 `bufferedAmount` 还会为零。载体计数在等待期间就在前进。

**读取 ws 私有 `_socket`。** 它不构成契约，而升级 socket 在 `handleUpgrade` 已可获得。

## 后果

只要载体持续接受下行字节，拥塞连接就会保持，代价是每个连接每个 tick 多读两次计数。真正掉线的对端、停止读取的对端以及字节不再排出的帧，仍会在两个间隔后终止；该修复不新增可调值，也不改动配置的间隔。该规则假定升级载体是 `net.Socket`——所有 HTTP 与 HTTPS 服务器都如此；不报告 `bytesWritten` 的载体保持原有行为。

## 验证

`packages/api/gateway/tests/stream-server.host.spec.ts` 覆盖持续载体进度、进度停滞、仅 Ping 自身增长、Pong 清零未命中计数，以及协商 `permessage-deflate` 后的同样进度。
