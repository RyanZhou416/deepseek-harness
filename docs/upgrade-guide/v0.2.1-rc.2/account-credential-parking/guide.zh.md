---
kind: upgrade-guide
description: "被拒绝的账号凭据现在标记为需要重新认证，而不再删除；账号状态新增 needs-reauth。"
---

# 账号凭据标记

[English](guide.md) | 中文

## 变更

当 Platform 或推理端拒绝存储的 DeepSeek 账号授权时，不再删除该授权。资料或余额接口返回 HTTP 401、响应码 `40003`、`rejectToken` 报告的推理 401，以及 issuer 与已配置 `platformOrigin` 不一致时，都会改为标记该记录：token 字节保留，payload 变为 version 2，并带有 `invalid.reason`（`needs-reauth` 或 `issuer-mismatch`）与 ISO 格式的 `invalid.at`。本 provider 不解释的字段会保留。没有该标记的 version 1 记录仍按有效状态加载，因此已有安装无需迁移。只要被标记的记录仍在存储中，账号状态就报告 `status: 'needs-reauth'` 并携带 `credentialIssue`；这些情况不再报告 `signed-out`，也不会发出 `deepseek-account/signed-out`。只有显式退登才会删除记录。被标记的授权绝不会用于 Platform 或推理请求，因此之后的模型请求会直接以 `ACCOUNT_SIGN_IN_REQUIRED` 失败，不再发起 HTTP 尝试。

## 迁移

1. 在 `AccountView.status` 的校验器和处理逻辑中接受 `needs-reauth`，并读取可选的 `credentialIssue`。被标记的账号在登录界面和详情查询上按未登录处理。
2. 不要把 `deepseek-account/session-expired` 当作记录已被移除的证据；它现在表示记录已被标记。需要移除时使用显式退登。
3. 展示账号状态时区分 `needs-reauth` 与 `signed-out`：凭据仍然存在，不得自动重建或清理。
4. 确认推理 401 之后的第二次模型请求立即以 `ACCOUNT_SIGN_IN_REQUIRED` 失败，并且凭证记录在用户退登前一直保留在磁盘上。
