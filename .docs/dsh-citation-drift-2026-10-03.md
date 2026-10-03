# dsh 引用漂移清單（2026-10-03）

**事由**：2026-10-03 把 `references/deepseek-harness` 從舊 HEAD 同步到最新（`git pull --ff-only`，一次拉進 **4,190 個檔案的變動**：修改 2,538、新增 593、刪除 489、改名 570），之後重掃本 repo 對 dsh 路徑的引用。這是 [`dsh-citation-drift-2026-10-01.md`](dsh-citation-drift-2026-10-01.md) 的**續篇**：那一份的對照基準 `639ed0153972` 正是這次同步前的舊 HEAD，所以它判的「無變動」只代表到 9/29 為止沒變，這一輪（9/29 → 10/03）它沒看過。

**對照版本**：舊 `639ed0153972`（2026-09-29，`release(dsh): 0.2.0-rc.2` 的合併，樹與其第二親代 `c1b47e41fcd` 相同）→ 新 `5badb15009a`（2026-10-03，`Merge pull request #5648`）。nexus 這邊掃的是 `320c0ec`（`develop`，同日 pull 後）。

**這次同步前，clone 其實是舊的**：同步前用 `git fetch` 再 `rev-list HEAD...origin/master` 判斷「已與遠端一致（0 落後）」，結果是錯的——同步時才發現落後 4,190 個檔案。淺 clone 上那個比對不可靠；**判斷 clone 新不新只認 `git rev-parse HEAD` 對 `git ls-remote origin refs/heads/master` 的 SHA 字串**（見記憶 `dsh-clone-goes-stale`）。

## 一、怎麼讀這份清單

- **這次更新不會讓 nexus 建置或執行壞掉。** 本 repo 沒有任何真實的 `import`、`package.json` 依賴或 `cordis.yml` 的 `name:` 指向 `@deepseek-ai/dsh-*`；出現這個字串的地方全是註解與文件。影響只在「引用與設計依據」。
- 「**有修改**」只表示那個檔案在新舊版本之間有差異，**不代表**被引用的那一段邏輯變了。第七節是對程式碼類引用實際讀過 diff 後的判讀。
- 「**無變動**」只代表這一輪路徑沒變，**不代表**當初引用的說法是對的（與 10-01 那份同）。
- 掃描方式：取出本 repo 所有受版控的文字檔（排除鎖檔與圖檔），抓出形如路徑的字串，與 dsh 在新舊兩棵樹上的檔案集合取交集；**不要求同一行有 SHA**，所以比 10-01 那份多抓到「路徑與 SHA 不在同一行」的引用。nexus 自己的樹裡也有同名路徑的命中（99 筆）已排除。
- **目錄型引用（例如只寫 `packages/foo/src`）沒有逐一檢查**，這份只涵蓋指到單一檔案的引用。
- 引用位置寫 `檔案:行`；同一檔案多次出現的文件引用寫 `×N`。

## 二、與 10-01 那份的對照

10-01 那份列了 152 筆引用，逐筆對上這一輪的變動：

| 結果 | 筆數 |
|---|---|
| 這一輪無變動 | 97 |
| 這一輪有修改 | 45 |
| 這一輪已刪除 | 1（`packages/core/session/src/invariant.ts`） |
| 本來就不在新 HEAD | 9（它自己的第五、六節，與這一輪無關） |

## 三、總覽

nexus 引用了 **350 個不重複的 dsh 檔案路徑**（含重複共 1,103 處引用位置）：

| 這一輪的狀態 | 路徑數 | 備註 |
|---|---|---|
| 已刪除 | 12 | 第四節；幾乎全是 `invariant.ts` 家族，見第七節 (1) |
| 已改名 | 3 | 第五節；全是 `.agents/notes` 從 `implemented/` 搬到 `archived/` |
| 有修改 | 95 | 第六節；其中 41 個有程式碼引用，其餘只被文件引用 |
| 無變動 | 240 | 不列 |

## 四、已刪除（12 個路徑）

引用處指向的檔案在新 HEAD 已不存在。**這一節是最硬的**：路徑不是「改了」，是沒有了。

| dsh 路徑 | 程式碼引用位置 | 文件引用位置 |
|---|---|---|
| `docs/subsystems/invariants.md` | `apps/harness/src/package-invariants.ts:6` | — |
| `packages/context/time-context/src/invariant.ts` | — | `.docs/subagent-session-log-survey.md` |
| `packages/core/session/src/invariant.ts` | `apps/harness/src/agent-factory.ts:913`、`apps/harness/src/package-invariants.ts:19`、`apps/harness/src/subagent-session-consumers.test.ts:11`、`packages/nexus-core/src/interrupted-turn.ts:22`、`packages/nexus-core/src/registry.ts:711`、`packages/nexus-core/src/session-registry.ts:16`、`packages/nexus-core/src/sessions.ts:34` | `.docs/dsh-citation-drift-2026-10-01.md`、`.docs/package-coupling-audit-2026-09-26.md`×2、`.docs/subagent-session-log-survey.md` |
| `packages/core/tools/src/invariant.ts` | `packages/nexus-core/src/session-registry.ts:21` | `.docs/subagent-session-log-survey.md` |
| `packages/goal/goal/src/invariant.ts` | `packages/nexus-core/src/session-log.ts:1100` | — |
| `packages/interaction/commands/src/invariant.ts` | `packages/nexus-plugin-commands/src/invariant.ts:10` | — |
| `packages/llm/llm-retry/src/invariant.ts` | — | `.docs/subagent-session-log-survey.md` |
| `packages/plan/plan-mode/src/invariant.ts` | `packages/nexus-plugin-plan-mode/src/invariant.ts:12` | — |
| `packages/sandbox/sandbox-policy/src/invariant.ts` | `packages/nexus-plugin-sandbox-policy/src/invariant.ts:4` | `.docs/package-coupling-audit-2026-09-26.md` |
| `packages/schedule/schedule/src/invariant.ts` | — | `.docs/subagent-session-log-survey.md` |
| `scripts/package-invariants.ts` | `apps/harness/src/package-invariants.ts:13` | — |
| `scripts/verify-package-invariants.ts` | `apps/harness/src/package-invariants.ts:13` | — |

## 五、已改名（3 個路徑）

| 舊路徑 | 新路徑 | 程式碼引用位置 | 文件引用位置 |
|---|---|---|---|
| `.agents/notes/implemented/architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.zh.md` | `.agents/notes/archived/architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.zh.md` | `packages/nexus-core/src/tool-result-pruner.ts:59` | — |
| `.agents/notes/implemented/bug-fix/2026-08-17-durable-web-queue-recovery.md` | `.agents/notes/archived/bug-fix/2026-08-17-durable-web-queue-recovery.md` | `apps/harness/src/thread-pump.ts:1068` | — |
| `.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.zh.md` | `.agents/notes/archived/feature/2026-06-21-subagent-capability-seam.zh.md` | — | `.docs/seven-layer-inventory-2026-09-19.md`、`.docs/seven-layer-inventory-2026-09-26.md` |

## 六、有修改（95 個路徑，依本次增刪行數由大到小）

`+/-` 是 `git diff --numstat 639ed0153972 HEAD` 在 dsh 上的數字，**只表示那個檔案有差異**，不代表被引用的那一段邏輯變了。引用處分成「程式碼」與「文件」兩欄；沒有程式碼引用的（只被 `.docs` 或 `.md` 引用）影響較小。

| +/- | dsh 路徑 | 程式碼引用位置 | 文件引用位置 |
|---|---|---|---|
| +168/-206 | `packages/client/ui-chat/src/client/chat/StatsPills.tsx` | `apps/web/src/lib/session-usage-view.ts:5`、`packages/nexus-wire/src/session-totals.ts:7` | — |
| +85/-22 | `packages/client/ui-chat/src/client/conversation-nodes/tool.ts` | `apps/harness/src/thread-pump.ts:39`、`apps/harness/src/thread-pump.ts:623`、`apps/harness/src/tool-result-text.ts:29`、`apps/harness/src/tool-result-text.ts:8`、`packages/nexus-wire/src/conversation.test.ts:447`、`packages/nexus-wire/src/conversation.ts:1595`（另 2 處） | `.docs/dsh-citation-drift-2026-10-01.md` |
| +36/-36 | `docs/event-producer-consumer.zh.md` | — | `.docs/dsh-citation-drift-2026-10-01.md`、`.docs/plugin-architecture-gap-survey.md` |
| +29/-40 | `scripts/run-gates.ts` | — | `.docs/decisions-2026-09-19.md`、`.docs/seven-layer-inventory-2026-09-19.md`、`.docs/seven-layer-inventory-2026-09-26.md` |
| +32/-36 | `docs/tool-catalog.zh.md` | `packages/nexus-plugin-plan-mode/src/index.ts:220` | — |
| +32/-32 | `docs/tool-catalog.md` | — | `.docs/decisions-2026-09-19.md`×2、`.docs/seven-layer-inventory-2026-09-19.md`、`.docs/seven-layer-inventory-2026-09-26.md` |
| +4/-51 | `packages/client/ui-conversation/src/client/queue/QueueDock.tsx` | `apps/web/src/components/queue-dock.tsx:75`、`apps/web/src/lib/steer-queue.ts:7` | — |
| +40/-12 | `packages/preset/agent-preset-registry/src/index.ts` | `packages/nexus-core/src/fold.ts:963` | `.docs/package-coupling-audit-2026-09-26.md`×2 |
| +12/-33 | `scripts/gen-tool-catalog.ts` | — | `.docs/decisions-2026-09-19.md`×2、`.docs/seven-layer-inventory-2026-09-19.md`、`.docs/seven-layer-inventory-2026-09-26.md`×2 |
| +28/-10 | `packages/bundle/web-app/cordis.patch.yml` | `apps/harness/cordis.yml:124`、`apps/harness/cordis.yml:346`、`apps/harness/cordis.yml:95`、`apps/harness/src/file-references.ts:35`、`apps/harness/src/plugin-config.test.ts:161`、`apps/harness/src/settings/recursion-limit.ts:33`（另 2 處） | `.docs/decisions-2026-09-19.md`×2、`.docs/package-coupling-audit-2026-09-26.md`、`.docs/plugin-architecture-gap-survey.md`×3、`.docs/seven-layer-inventory-2026-09-19.md`、`.docs/seven-layer-inventory-2026-09-26.md`×41 |
| +27/-8 | `packages/bundle/web-app/src/index.ts` | `apps/harness/src/serve.ts:272` | `.docs/dsh-citation-drift-2026-10-01.md` |
| +28/-7 | `packages/client/ui-tool/src/client/tool/models/tool-call-model.ts` | `apps/web/src/lib/tool-view.ts:3`、`packages/nexus-wire/src/conversation.ts:1596`、`packages/nexus-wire/src/conversation.ts:223` | `.docs/dsh-citation-drift-2026-10-01.md`、`.docs/package-coupling-audit-2026-09-26.md` |
| +32/-3 | `packages/client/ui-workspace/src/client/navigation.ts` | `apps/web/src/lib/new-conversation.ts:3` | `.docs/dsh-citation-drift-2026-10-01.md` |
| +27/-7 | `packages/api/session-controller/src/list.ts` | `apps/harness/src/session-list.ts:4`、`apps/harness/src/session-list.ts:76`、`apps/harness/src/settings/thread-search.ts:24`、`apps/harness/src/thread-search.ts:5`、`apps/harness/src/wire-handler.ts:291` | `.docs/dsh-citation-drift-2026-10-01.md`×2 |
| +12/-11 | `packages/core/tools/src/ptc.ts` | `packages/nexus-plugin-quickjs/src/index.ts:77` | `.docs/dsh-citation-drift-2026-10-01.md` |
| +10/-9 | `scripts/gen-cordis-catalog.ts` | — | `.docs/kernel-split-tradeoff.md` |
| +16/-0 | `packages/bundle/web-app/presets/cordis.patch.yml` | — | `.docs/seven-layer-inventory-2026-09-26.md`×2 |
| +16/-0 | `packages/bundle/web-app/presets/ptc.patch.yml` | — | `.docs/seven-layer-inventory-2026-09-26.md` |
| +16/-0 | `packages/bundle/web-app/presets/standard.patch.yml` | — | `.docs/package-coupling-audit-2026-09-26.md`、`.docs/seven-layer-inventory-2026-09-26.md`×16 |
| +4/-12 | `packages/credentials/credentials-local/src/index.ts` | — | `.docs/dsh-citation-drift-2026-10-01.md`、`.docs/seven-layer-inventory-2026-09-26.md` |
| +11/-4 | `packages/api/session-controller/src/index.ts` | `packages/nexus-wire/src/protocol.ts:560` | `.docs/dsh-citation-drift-2026-10-01.md` |
| +0/-15 | `packages/bundle/sdk-minimal/cordis.patch.yml` | — | `.docs/seven-layer-inventory-2026-09-19.md`、`.docs/seven-layer-inventory-2026-09-26.md`×5 |
| +0/-14 | `packages/client/ui-tool/src/client/tool/models/raw-tool-call.ts` | `apps/harness/src/tool-result-text.test.ts:45` | `.docs/dsh-citation-drift-2026-10-01.md` |
| +8/-4 | `packages/goal/goal-round-driver/src/index.ts` | `apps/harness/src/goal-driver.ts:117`、`apps/harness/src/goal-driver.ts:124`、`apps/harness/src/goal-driver.ts:135`、`apps/harness/src/goal-driver.ts:164`、`apps/harness/src/thread-pump.ts:1190`、`packages/nexus-core/src/max-tokens.ts:22`（另 1 處） | `.docs/dsh-citation-drift-2026-10-01.md`、`.docs/package-coupling-audit-2026-09-26.md`×7、`.docs/seven-layer-inventory-2026-09-26.md`×2 |
| +11/-1 | `python/sdk-runtime/package.json` | — | `.docs/plugin-architecture-gap-survey.md` |
| +6/-5 | `packages/core/tools/README.zh.md` | — | `.docs/seven-layer-inventory-2026-09-19.md`、`.docs/seven-layer-inventory-2026-09-26.md`×3 |
| +2/-9 | `packages/llm/llm/src/index.ts` | — | `.docs/jev-gatekeeper-survey.md` |
| +5/-5 | `.agents/notes/implemented/feature/2026-07-06-approval-seam.md` | — | `.docs/structured-input-survey.md` |
| +5/-5 | `.agents/notes/implemented/feature/2026-07-06-approval-seam.zh.md` | — | `.docs/plugin-architecture-gap-survey.md` |
| +2/-8 | `packages/core/session/src/surface.ts` | `packages/nexus-core/src/logged-message.ts:10`、`packages/nexus-core/src/max-tokens.ts:23` | — |
| +1/-8 | `packages/todo/tool-todo/package.json` | — | `.docs/package-coupling-audit-2026-09-26.md` |
| +6/-3 | `vendor/loader/src/config/entry.ts` | `packages/nexus-core/src/load.ts:122`、`packages/nexus-core/src/plugin.ts:10`、`packages/nexus-core/src/plugin.ts:119`、`packages/nexus-core/src/plugin.ts:273`、`packages/nexus-core/src/plugin.ts:86` | `.docs/development-plan.md`、`.docs/package-coupling-audit-2026-09-26.md`×3 |
| +3/-5 | `docs/subsystems/subagent.zh.md` | `apps/harness/src/background-subagents.ts:20`、`apps/harness/src/background-subagents.ts:385`、`packages/nexus-wire/src/protocol.ts:737` | `.docs/dsh-citation-drift-2026-10-01.md` |
| +4/-4 | `packages/client/AGENTS.md` | — | `.docs/agent-ui-library-survey.md` |
| +2/-6 | `packages/context/agent-instructions/src/render.ts` | `packages/nexus-plugin-agent-instructions/src/render.test.ts:2`、`packages/nexus-plugin-agent-instructions/src/render.ts:4` | `.docs/dsh-citation-drift-2026-10-01.md` |
| +2/-6 | `packages/core/session/src/index.ts` | `packages/nexus-core/src/conversation-replay.ts:8`、`packages/nexus-core/src/session-log.ts:1016`、`packages/nexus-core/src/session-log.ts:1075`、`packages/nexus-core/src/session-log.ts:1101`、`packages/nexus-core/src/session-log.ts:29` | `.docs/dsh-citation-drift-2026-10-01.md`、`.docs/session-event-log-survey.md`、`.docs/subagent-session-log-survey.md` |
| +3/-4 | `packages/boot/app-boot/README.zh.md` | `apps/harness/src/plugin-config-wire.test.ts:285`、`apps/harness/src/plugin-config.test.ts:615`、`apps/harness/src/plugin-config.test.ts:725`、`apps/harness/src/plugin-config.ts:248`、`apps/harness/src/plugin-config.ts:943`、`apps/harness/src/serve.ts:494`（另 3 處） | `.docs/development-plan.md`、`.docs/dsh-citation-drift-2026-10-01.md` |
| +3/-4 | `packages/context/time-context/README.zh.md` | — | `.docs/dsh-citation-drift-2026-10-01.md`×2、`.docs/seven-layer-inventory-2026-09-26.md` |
| +4/-2 | `apps/cli/reference/README.zh.md` | `packages/nexus-core/src/config-schema.ts:4` | `.docs/dsh-citation-drift-2026-10-01.md` |
| +3/-3 | `docs/cookbook/extension-cookbook.zh.md` | — | `.docs/dsh-citation-drift-2026-10-01.md`、`.docs/seven-layer-inventory-2026-09-19.md`、`.docs/seven-layer-inventory-2026-09-26.md` |
| +3/-3 | `docs/subsystems/todo.zh.md` | — | `.docs/todo-design-survey.md`×2 |
| +5/-1 | `packages/fs/tool-fs/src/write.ts` | `packages/nexus-core/src/fs-tool-errors.ts:20` | — |
| +2/-4 | `packages/session/session-telemetry/README.md` | — | `.docs/seven-layer-inventory-2026-09-26.md` |
| +3/-3 | `packages/session/session-telemetry/src/index.ts` | `packages/nexus-core/src/session-telemetry-coordinator.ts:113` | `.docs/dsh-citation-drift-2026-10-01.md`、`.docs/session-event-log-survey.md` |
| +3/-2 | `apps/cli/package.json` | — | `.docs/dsh-citation-drift-2026-10-01.md`、`.docs/seven-layer-inventory-2026-09-26.md` |
| +0/-5 | `packages/bundle/base/README.md` | — | `.docs/dsh-citation-drift-2026-10-01.md`×2、`.docs/seven-layer-inventory-2026-09-26.md` |
| +2/-3 | `packages/goal/goal-round-driver/README.zh.md` | — | `.docs/dsh-citation-drift-2026-10-01.md`、`.docs/plugin-architecture-gap-survey.md` |
| +2/-3 | `packages/mcp/mcp-client/README.zh.md` | — | `.docs/seven-layer-inventory-2026-09-26.md`×3 |
| +2/-2 | `docs/architecture.zh.md` | — | `.docs/development-plan.md`、`AGENTS.md` |
| +2/-2 | `docs/subsystems/README.zh.md` | — | `.docs/plugin-architecture-gap-survey.md` |
| +2/-2 | `docs/testing.md` | — | `.docs/seven-layer-inventory-2026-09-26.md` |
| +2/-2 | `packages/browser-use/browser-use/README.i18n.yaml` | — | `.docs/seven-layer-inventory-2026-09-26.md` |
| +1/-3 | `packages/client/connection/README.md` | — | `.docs/seven-layer-inventory-2026-09-26.md` |
| +2/-2 | `packages/compaction/compaction/src/types.ts` | `packages/nexus-core/src/session-log.ts:607` | — |
| +2/-2 | `packages/core/session/src/types.ts` | `packages/nexus-core/src/session-log.ts:195`、`packages/nexus-core/src/session-log.ts:199`、`packages/nexus-core/src/session-log.ts:381`、`packages/nexus-core/src/session-log.ts:517`、`packages/nexus-core/src/session-log.ts:757`、`packages/nexus-core/src/session-log.ts:926`（另 5 處） | `.docs/dsh-citation-drift-2026-10-01.md`×3、`.docs/package-coupling-audit-2026-09-26.md`×4、`.docs/seven-layer-inventory-2026-09-19.md`×2、`.docs/seven-layer-inventory-2026-09-26.md`×7 |
| +2/-2 | `packages/mcp/README.zh.md` | — | `.docs/seven-layer-inventory-2026-09-19.md`、`.docs/seven-layer-inventory-2026-09-26.md` |
| +1/-2 | `packages/AGENTS.md` | — | `.docs/srp-audit-2026-09-19.md`、`AGENTS.md` |
| +1/-2 | `packages/client/ui-tool/src/client/tool/models/diff-card-model.ts` | `apps/web/src/lib/tool-diff.ts:5` | — |
| +1/-2 | `packages/context/session-reference/README.zh.md` | — | `.docs/seven-layer-inventory-2026-09-26.md` |
| +1/-2 | `packages/credentials/authorization/README.zh.md` | — | `.docs/dsh-citation-drift-2026-10-01.md`×2、`.docs/seven-layer-inventory-2026-09-26.md` |
| +1/-2 | `packages/goal/goal/README.zh.md` | — | `.docs/decisions-2026-09-19.md`、`.docs/dsh-citation-drift-2026-10-01.md`、`.docs/plugin-architecture-gap-survey.md`、`.docs/seven-layer-inventory-2026-09-26.md` |
| +1/-2 | `packages/interaction/commands/README.zh.md` | `apps/harness/src/cli.ts:622` | — |
| +1/-2 | `packages/interaction/permission-presets/README.zh.md` | `packages/nexus-core/src/session-log.ts:661` | — |
| +1/-2 | `packages/plan/plan-mode/README.zh.md` | `apps/harness/src/plan-mode.test.ts:116`、`packages/nexus-plugin-plan-mode/src/index.ts:209` | — |
| +1/-2 | `packages/plan/plan-mode/src/index.ts` | `apps/harness/src/delegated-subagent.test.ts:287`、`apps/harness/src/plan-mode.test.ts:297`、`packages/nexus-core/src/registry.ts:744`、`packages/nexus-core/src/session-log.ts:691`、`packages/nexus-plugin-ask-user/src/index.ts:131`、`packages/nexus-plugin-plan-mode/src/command.ts:36`（另 4 處） | `.docs/development-plan.md`、`.docs/dsh-citation-drift-2026-10-01.md` |
| +0/-3 | `packages/skill/tool-workspace-dependencies/README.md` | — | `.docs/dsh-citation-drift-2026-10-01.md`、`.docs/seven-layer-inventory-2026-09-26.md` |
| +1/-1 | `apps/desktop-host/src/index.ts` | — | `.docs/package-coupling-audit-2026-09-26.md` |
| +1/-1 | `docs/subsystems/persistence.zh.md` | `apps/harness/src/jsonl-session-store.ts:4`、`packages/nexus-core/src/session-persistence.ts:5`、`packages/nexus-core/src/session-store.ts:5` | `.docs/dsh-citation-drift-2026-10-01.md` |
| +0/-2 | `packages/browser-use/browser-use/README.md` | — | `.docs/seven-layer-inventory-2026-09-26.md` |
| +1/-1 | `packages/bundle/base/package.json` | `packages/nexus-plugin-agent-instructions/src/index.ts:133` | `.docs/plugin-architecture-gap-survey.md` |
| +1/-1 | `packages/client/ui-conversation/package.json` | — | `.docs/package-coupling-audit-2026-09-26.md` |
| +0/-2 | `packages/client/ui-model-selection/README.md` | — | `.docs/seven-layer-inventory-2026-09-26.md` |
| +1/-1 | `packages/core/agent/src/runtime-types.ts` | — | `.docs/dsh-citation-drift-2026-10-01.md`×2、`.docs/jev-gatekeeper-survey.md`、`.docs/plugin-architecture-gap-survey.md` |
| +0/-2 | `packages/experimental/auto-review/README.md` | — | `.docs/seven-layer-inventory-2026-09-26.md` |
| +0/-2 | `packages/feedback/message-feedback/README.md` | `packages/nexus-plugin-feedback/src/invariant.ts:4` | `.docs/dsh-citation-drift-2026-10-01.md` |
| +1/-1 | `packages/goal/README.zh.md` | `apps/harness/src/assembly-root.ts:138` | `.docs/dsh-citation-drift-2026-10-01.md`、`.docs/plugin-architecture-gap-survey.md` |
| +0/-2 | `packages/llm/llm-pi-ai/README.md` | `apps/harness/cordis.yml:466`、`apps/harness/src/settings/live-model.ts:74` | — |
| +1/-1 | `packages/llm/llm-pi-ai/package.json` | `apps/harness/src/live-model.ts:815` | — |
| +0/-2 | `packages/llm/llm-retry/README.md` | — | `.docs/seven-layer-inventory-2026-09-26.md` |
| +1/-1 | `packages/llm/llm/README.zh.md` | — | `.docs/dsh-citation-drift-2026-10-01.md`、`.docs/seven-layer-inventory-2026-09-26.md` |
| +1/-1 | `packages/llm/llm/src/error.ts` | `packages/nexus-core/src/observation.ts:142`、`packages/nexus-core/src/tool-events.ts:36` | `.docs/dsh-citation-drift-2026-10-01.md` |
| +1/-1 | `packages/session/session-format-v3-to-v4/package.json` | — | `.docs/dsh-citation-drift-2026-10-01.md`、`.docs/seven-layer-inventory-2026-09-26.md` |
| +0/-2 | `packages/subagent/subagent/src/index.ts` | — | `.docs/seven-layer-inventory-2026-09-26.md` |
| +1/-1 | `vendor/cordis/package.json` | — | `.docs/kernel-split-tradeoff.md` |
| +1/-0 | `apps/cli/tests/web-agent-presets.e2e.ts` | — | `.docs/package-coupling-audit-2026-09-26.md`×3 |
| +1/-0 | `packages/boot/app-boot/src/index.ts` | `apps/harness/src/launch-env.ts:5`、`apps/harness/src/plugin-config.ts:13`、`apps/harness/src/plugin-config.ts:313`、`apps/harness/src/plugin-config.ts:530`、`apps/harness/src/plugin-config.ts:596`、`apps/harness/src/plugin-config.ts:803`（另 1 處） | `.docs/dsh-citation-drift-2026-10-01.md` |
| +0/-1 | `packages/compaction/compaction-basic/README.zh.md` | `apps/harness/src/agent-factory.ts:526` | `.docs/dsh-citation-drift-2026-10-01.md` |
| +0/-1 | `packages/context/file-reference-local/README.zh.md` | — | `.docs/seven-layer-inventory-2026-09-26.md` |
| +0/-1 | `packages/core/agent-default-model/README.md` | — | `.docs/seven-layer-inventory-2026-09-26.md` |
| +0/-1 | `packages/core/system-prompt/README.md` | `packages/nexus-core/src/registry.ts:419`、`packages/nexus-plugin-system-prompt/src/index.ts:11` | `.docs/seven-layer-inventory-2026-09-26.md` |
| +0/-1 | `packages/credentials/credentials-local/README.zh.md` | — | `.docs/dsh-citation-drift-2026-10-01.md`、`.docs/seven-layer-inventory-2026-09-26.md` |
| +0/-1 | `packages/goal/tool-goal/README.md` | — | `.docs/seven-layer-inventory-2026-09-26.md` |
| +0/-1 | `packages/guard/timeout-policy/README.zh.md` | — | `.docs/seven-layer-inventory-2026-09-26.md` |
| +0/-1 | `packages/ptc-runtime/ptc-runtime-node/README.md` | — | `.docs/seven-layer-inventory-2026-09-26.md` |
| +0/-1 | `packages/spill/spill-policy/README.zh.md` | `apps/harness/src/agent-factory.ts:441` | `.docs/dsh-citation-drift-2026-10-01.md` |

## 七、判讀：哪些變動值得讀

以下是對程式碼類引用實際讀過 diff 的結果。**沒有逐一讀完 41 個有程式碼引用的路徑**，只讀了改動量較大或位置關鍵的；沒提到的，要不是 diff 只動註解與匯出清單，就是沒讀。

### (1) dsh 移除了整套 invariant 機制（影響最大，需要決策）

- dsh 提交 `f028f25667d`（2026-09-30，`refactor: remove runtime invariant plugins`）：刪掉 `@deepseek-ai/dsh-invariants`、每個套件的 `./invariant` 外掛與測試、invariant 閘門與 Vitest 設定、scoped-event resolver 產生器，並附升級指南 `docs/upgrade-guide/v0.2.0-rc.2/remove-runtime-invariants/guide.md`。
- nexus 側有一整套照它做的東西：`apps/harness/src/package-invariants.ts`（檔頭明寫「抄 dsh 的」，並登記了一條反向偏離 [#454](https://github.com/DemianLi/nexus-agent/issues/454)）、`packages/nexus-core/src/invariant.ts`、`invariants.ts`，以及各外掛的 `invariant.ts`（目前檔名含 `invariant` 的受版控檔共 37 個）。
- 第四節那 12 個已刪除路徑，絕大多數就是這一族，被 nexus 的 14 個檔案引用。其中 `packages/nexus-core/src/session-registry.ts:16` 拿 `core/session/src/invariant.ts:218-220` 當論據，說明「dsh 的消費者訂的是 session 註冊表」。
- 依 AGENTS.md「技術實現一律以 dsh 實際做法為標準」，這代表 nexus 的 invariant 機制從「照 dsh」變成「dsh 已不做」。**這是設計決策，不在這份清單的範圍**（決策與第一刀範圍見 [`invariant-companions-decision-2026-10-03.md`](invariant-companions-decision-2026-10-03.md)）；至少要把相關檔頭的「照 dsh」改成登記過的偏離，或決定對齊移除。dsh 為什麼移除，理由在上面那份升級指南，本稽核沒有讀完。

### (2) `goal-round-driver` 的取消路徑加了一格

`packages/goal/goal-round-driver/src/index.ts`（+8/-4）：目標回合被取消、而預約還排在佇列裡時，agent 一到 idle 就把預約撤回（`agent.inbox.remove(attempt.messageId)`），避免排在它後面的人類輸入被卡住；原本只做 `ctx.goals.pause`。`apps/harness/src/goal-driver.ts` 對這個檔有 7 處引用（皆帶 SHA `477b4f4`，引用本身仍成立），其中登記過的偏離（「我們只收回行程內授權、不暫停」）對照的正是被改的這一段。**nexus 有沒有同樣的「預約卡住人類輸入」風險，未驗證。**

### (3) `session-controller` 的清單／搜尋加了分段讓出

`packages/api/session-controller/src/list.ts`（+27/-7）與 `index.ts`（+11/-4）：新增設定 `listWorkSliceMs`、建構子多一個 `workSliceMs`、迴圈裡加 `yieldDeadline` 與 `signal?.throwIfAborted()`。`apps/harness/src/session-list.ts:4`、`apps/harness/src/thread-search.ts:5` 都是「照 dsh」做的。**只讀了 diff 的前段，沒有讀完整個 search 路徑。**

### (4) web 工具卡的開卡時機（只影響一句描述）

dsh 提交 `91818992b05`（2026-09-30，`perf(web): finish incremental tool argument optimizations`）刪掉 `partial.ts`，並讓 `conversation-nodes/tool.ts` 在 `assistant/live-chunk` 的 `tool-call-delta` 到達時就以 `phase: 'preparing'` 開卡。`apps/harness/src/thread-pump.ts:39` 寫的「dsh 的 web 工具卡只從會話日誌導出，`tool/call` 開卡」（引 `tool.ts:40-66`，`c291e79`）對最新版已不成立；對 `c291e79` 仍成立。web 的 UI/UX 本來就不以 dsh 為標準（AGENTS.md），所以這只是一句過期描述，不是偏離。

### (5) 看起來有變、其實不影響

- `packages/llm/llm/src/error.ts`：只是註解把 `INVARIANT` 從錯誤碼範例拿掉（與 (1) 同源）。`tool-events.ts:36` 引的 `HarnessError` 本體沒動。
- `packages/core/tools/src/ptc.ts`：改的是給模型看的 `run_code` 說明（要求參數順序 `description` 在 `code` 前）。nexus 的 `nexus-plugin-quickjs` **沒有抄那段說明文字**，所以不受影響；它引的 `ptc.ts:165-180`（拋、不回字串）不在被改的區段，但行號可能平移。
- `packages/core/session/src/index.ts`、`types.ts`、`plan-mode`、`session-telemetry`、`agent-instructions/render.ts`：diff 只有註解、標註（`@dshScopeScan unsupported`）與 Agent Note 指標。
- `packages/boot/app-boot/src/index.ts`：只多一個匯出 `ProfileRuntimeResolution`；`launch-env.ts:5` 引的 `loadLayeredEnv` 沒動。
- 有 SHA 的引用以該 SHA 為準，不受這次更新影響；要在新 HEAD 重讀時，行號可能平移。

## 八、沒涵蓋的

- **GitHub issue／PR 裡的 dsh SHA 與路徑引用**沒掃（地圖 [#26](https://github.com/DemianLi/nexus-agent/issues/26)、[#372](https://github.com/DemianLi/nexus-agent/issues/372) 等的內文與留言）。
- **「無變動」的 240 個路徑**沒有核對引用的說法本身對不對。
- **第六節的 95 個路徑**，只讀了第七節提到的；文件類引用（`.docs/*.md`）只看了改動量，沒有讀內容。
- 掃描是字串比對，**會漏掉換行拆開、或不帶目錄的檔名引用**，也可能把巧合同名的字串當成引用（已排除 nexus 自己也有的路徑，但 dsh 內部同名的不會被排除）。

## 九、重跑方式

這份清單由一支一次性腳本產生，不在版控裡；要重產就是重做同樣的掃描：

1. `git -C references/deepseek-harness diff --name-status <舊SHA> HEAD`（變動清單）與 `--numstat`（增刪行數）。
2. `git ls-tree -r --name-only <舊SHA>` 與 `HEAD`，得到 dsh 在新舊兩棵樹上的檔案集合。
3. 對本 repo 的 `git ls-files`（排除鎖檔與圖檔），用路徑形狀的正則逐行抽出字串，留下在 dsh 集合裡、且不在 nexus 自己的樹裡的。
4. 依第 1 步的狀態（`D`／`R`／`M`）分組，第六節再依增刪行數排序，並把引用位置拆成程式碼（非 `.docs/`、非 `.md`）與文件兩欄。

動手前先確認 clone 是最新：`git rev-parse HEAD` 對 `git ls-remote origin refs/heads/master` 的 SHA 要相同。
