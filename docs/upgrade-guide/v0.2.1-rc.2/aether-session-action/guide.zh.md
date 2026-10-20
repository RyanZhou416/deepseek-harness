---
kind: upgrade-guide
description: "可选 AetherShell 适配器用带必需 action 的 aether_session 替代五个持久会话工具。"
---

# 使用带显式操作的统一 AetherShell 会话工具

[English](guide.md) | 中文

## 变更

可选 AetherShell 适配器暴露七个工具。`aether_session` 替代 `aether_session_open`、`aether_session_eval`、`aether_session_read`、`aether_session_list` 和 `aether_session_close`，旧名称不保留为别名。六个发现／执行／取回工具不变。会话 id、结果字段、原生状态、所有权、文件策略检查和超时／取消清理保留原有语义。已保存的记录仍是历史；执行前须更新使用退役名称的待处理或重放调用。

## 迁移

1. 安装与 Host 构建配套的新适配器，再重启 DSH 加载它。将客户端调用、自动化和工具策略中的旧会话工具名替换为 `aether_session`，并添加对应 `action`：

   | 旧工具后缀 | 新 action | 参数 |
   |---|---|---|
   | `_open` | `open` | 可选 `cwd`、`name`、`timeoutMs` |
   | `_eval` | `eval` | 必须 `session_id`、`code`；可选 `timeoutMs` |
   | `_read` | `read` | 仅必须 `session_id` |
   | `_list` | `list` | 可选 `usage`、`timeoutMs`，不接受 id |
   | `_close` | `close` | 必须 `session_id`；可选 `timeoutMs` |

2. 删除与所选操作无关的参数。这些参数会在查找会话或产生效果前被拒绝，包括 `read` 上的 `timeoutMs`。允许 `aether_session` 的工具策略会允许全部五项操作；本次变更不新增按操作授权的规则。
3. 确认 `{"action":"open"}` 返回 `session_id`，用 `{"action":"eval","session_id":"…","code":"…"}` 连续求值两次验证状态保留，再用 `{"action":"close","session_id":"…"}` 关闭。确认工具发现只列出一个 `aether_session`，不列出五个退役名称。迁移记录或重开会话时，不要重放已有副作用。
