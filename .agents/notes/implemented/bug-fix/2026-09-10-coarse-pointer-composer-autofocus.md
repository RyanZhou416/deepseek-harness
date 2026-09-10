# Agent Note: Coarse-pointer composer autofocus

Status: implemented

English | [中文](2026-09-10-coarse-pointer-composer-autofocus.zh.md)

## Problem

The resident composer focuses itself after mount and every Session change so a desktop user can type immediately and a restored caret becomes visible. On a touch-first browser, the same programmatic focus summons the software keyboard after the user selects a Session row, obscuring the conversation before the user chooses to write.

Viewport width does not identify the input device. A narrow desktop window may use a keyboard and mouse, while a tablet or hybrid device may have a wide viewport.

## Decision

`InputBar` reads the primary-pointer media query `(pointer: coarse)` when its mount or Session-change focus effect runs. A coarse primary pointer suppresses that automatic focus. A fine primary pointer, or a browser without `matchMedia`, retains automatic focus and restored-caret reveal.

The policy affects only programmatic navigation focus. A direct gesture on the editor follows native browser focus behavior, so touch-first users can still open the software keyboard by selecting the composer. The effect reads current media state without retaining a listener.

## Alternatives considered

**Disable automatic focus below a viewport breakpoint.** Rejected because layout width and input precision are independent; this would regress narrow desktop windows and miss wide touch devices.

**Use `maxTouchPoints` or `(any-pointer: coarse)`.** Rejected because those signals also match hybrid desktops whose primary mouse remains precise. The primary-pointer query preserves their desktop workflow.

**Remove automatic focus on every device.** Rejected because desktop Session navigation intentionally returns users to immediate typing and reveals a restored caret without another click.

## Consequences

Touch-first Session navigation leaves the active element outside the composer and does not request a software keyboard. A coarse-pointer device with a hardware keyboard also requires a direct composer gesture; this is the accepted trade-off for avoiding unsolicited mobile keyboard presentation.

The focused unit tests replace and restore `matchMedia` for fine and coarse primary pointers. The Web composition test uses an isolated touch-enabled Chromium page, selects two real Session rows, and observes that the resident contenteditable never becomes `document.activeElement`.
