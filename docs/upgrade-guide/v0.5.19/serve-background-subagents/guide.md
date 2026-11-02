---
kind: upgrade-guide
description: serve 的委派工具改成背景續行，子代理做完會叫醒主對話多跑一輪；要回到 v0.5.19 的一次性委派，把 backgroundMode 改成 one-shot。
---

# `serve` 的子代理預設在背景跑

## 變更

v0.5.19 的模型委派子代理只有基座的 `task`：一次性、等結果。新版（PR #855）在出貨清單加了 `background-subagents` 那一列，
`serve` 出貨值是 `backgroundMode: continuable`：

- 模型看到的委派工具換成 `subagent`，派出去預設在背景跑、當場回編號；另有 `list_agents`、`interrupt_agent`、`send_message`。
- 子代理做完會**叫醒主對話多跑一輪**，模型用量跟著增加；一次派多個，主對話的輪數大約是「派出去那一輪 ＋ 每個子代理各一輪」。
- 上限是**每個主對話各 8 個**（`maxActiveSubagents`），不是整台主機的。
- 主對話按停止不連帶停背景子代理。
- 每個背景子代理有自己的會話日誌，路徑是 `<主對話會話>/<編號>`。

REPL 與一次性模式不讀這一列，仍是一次性。細節見 [`docs/operations.md`](../../../operations.md) 的「`serve` 出廠就是背景續行」那一段。

受影響的：所有 `serve` 主機。

## 遷移

1. 要新的預設：不用動，留意模型用量與同時在跑的子代理數。要壓上限就調小 `maxActiveSubagents`。
2. 要維持 v0.5.19 的一次性委派：把 `background-subagents` 那一列的 `backgroundMode` 改成 `one-shot`
   （`plugin config set background-subagents --file -`，或在 `--patch` 覆寫檔寫；`config` 是整份替換，`maxActiveSubagents` 一起寫出來）。
   這一列是必掛的，`config` 寫壞 serve 會起不來。
3. 確認：`--dump-config` 的 `background-subagents` 那一列是你要的值。
