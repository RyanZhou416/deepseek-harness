# Agent Note: 粗指针 composer 自动聚焦

Status: implemented

[English](2026-09-10-coarse-pointer-composer-autofocus.md) | 中文

## 问题

常驻 composer 会在挂载和每次 Session 变化后聚焦自身，让桌面用户可以立即输入并显示恢复的光标。在触屏优先的浏览器中，用户选择 Session 行后，同一个程序化聚焦会唤起软键盘，在用户决定输入前遮挡对话。

viewport 宽度不能识别输入设备。狭窄的桌面窗口可能使用键盘和鼠标，平板或混合设备也可能具有较宽的 viewport。

## 决策

`InputBar` 在挂载或 Session 变化的聚焦 effect 运行时读取主指针媒体查询 `(pointer: coarse)`。粗主指针会阻止该自动聚焦；细主指针或没有 `matchMedia` 的浏览器继续自动聚焦并显示恢复的光标。

该策略只影响程序化导航聚焦。用户直接操作编辑器时仍遵循浏览器原生聚焦行为，因此触屏优先的用户仍可通过选择 composer 打开软键盘。effect 会读取当前媒体状态，但不保留 listener。

## 备选方案

**在 viewport 小于某个断点时禁用自动聚焦。** 拒绝，因为布局宽度与输入精度相互独立；该方案会使狭窄桌面窗口退化，并漏掉宽屏触摸设备。

**使用 `maxTouchPoints` 或 `(any-pointer: coarse)`。** 拒绝，因为这些信号也会命中以精确鼠标为主指针的混合桌面设备。主指针查询可保留其桌面工作流。

**在所有设备上移除自动聚焦。** 拒绝，因为桌面 Session 导航需要让用户立即继续输入，并在无需再次点击时显示恢复的光标。

## 影响

触屏优先的 Session 导航会让 active element 保持在 composer 外，也不会请求软键盘。带硬件键盘的粗指针设备同样需要直接操作 composer；这是避免移动端键盘未经请求出现所接受的取舍。

针对性单元测试会分别替换并恢复细主指针和粗主指针的 `matchMedia`。Web 组合测试使用隔离的触摸 Chromium 页面，选择两个真实 Session 行，并观察常驻 contenteditable 始终不会成为 `document.activeElement`。
