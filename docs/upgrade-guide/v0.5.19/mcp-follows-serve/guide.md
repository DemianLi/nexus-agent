---
kind: upgrade-guide
description: 沒宣告 sandbox 的 stdio MCP 改成跟著 serve 走：serve 被硬殺時它也被 SIGKILL，不再留成孤兒。
---

# 沒宣告 sandbox 的 stdio MCP 跟著 serve 走

## 變更

v0.5.19 沒宣告 `sandbox` 的 stdio MCP 由 serve 直接起。serve 被 `kill -9` 或 OOM 殺掉時，不理 stdin 結束的 server 會留下來，父行程變 1，重啟後又多起一支，每崩潰一次多一支。

新版（[#2197](https://github.com/DemianLi/nexus-agent/issues/2197)）在 Linux 上改經 spawner 的 `--guard` 起：不上沙箱，只設 `PR_SET_PDEATHSIG`，起它的行程一死，server 就收到 SIGKILL。pid、PATH、env、cwd、stdio、行程群組都跟直接起一樣，收尾走完的正常關閉也一樣；行程沒收完子行程就 `exit` 時，子行程改成被 SIGKILL。CLI 與 `plugin` 指令起的 stdio MCP 也一樣。

受影響的：靠「serve 死了 server 還活著」做事的部署，例如 serve 崩潰後還要讓 server 把手上的工作做完。這類 server 現在會跟著被 SIGKILL，收不到 SIGTERM。自己 daemon 化（fork 之後父行程退出）的 server 不受影響。

沒有 spawner 的主機（非 Linux、找不到執行檔）照舊直接起，serve 起動講一行 `[MCP] 這台主機沒有 spawner…`。孫行程（`npx xxx` 底下的 server）與 setuid／setgid 程式收不到，見 [`docs/operations.md`](../../../operations.md)〈孤兒行程〉。

## 遷移

1. 找出 `command` 沒宣告 `sandbox`、又需要活過 serve 的 stdio MCP。一般的 server 不用改。
2. 真的要活過 serve 的，改成自己 daemon 化，或由 systemd 這類行程管理器起，再用 HTTP 連線。
3. 確認：在測試機起 serve，等 MCP 連上，`kill -9 <serve pid>`，一秒後 `pgrep -f <command>` 找不到那支 server。
