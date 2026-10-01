# dsh／Proteus 引用漂移清單（2026-10-01）

**事由**：2026-10-01 把 `references/` 底下的借鑑倉庫全部更新到最新（`deepseek-harness` 從 detached `477b4f4` 切回 `master`、一口氣前進 3346 個 commit），之後掃一遍本 repo 引用過的路徑，看被引用的檔案在「引用當時的 SHA」與新 HEAD 之間有沒有變動。這份是**只讀**的盤點：沒有改任何引用，哪些要重寫、哪些要開卡，由使用者決定。

**對照版本**：dsh 新 HEAD `639ed0153972`（2026-09-29，`release(dsh): 0.2.0-rc.2` 的合併）；Proteus 新 HEAD `0d37763`（舊引用 `962304b3`）。

## 一、怎麼讀這份清單

- 「**有變動**」只表示那個檔案在新舊版本之間有差異（`+新增/-刪除` 行數），**不代表**被引用的那一段邏輯變了；要看再 `git -C references/deepseek-harness diff <舊SHA> HEAD -- <路徑>`。
- 「**無變動**」只代表路徑沒變，**不代表**當初引用的說法是對的。
- 掃描範圍：本 repo 的 `.md`／`.ts`／`.tsx`（排除 `node_modules`、`references/`、`.claude/`、`.cache/`），抓「**同一行同時有 dsh SHA 與路徑**」的引用。路徑與 SHA 不在同一行的引用**不在**這份裡；本 repo 自己的路徑（`apps/harness`、`apps/web`、`packages/nexus-*` 等）排除。
- 同一行有多個 SHA 時，路徑先配給行內每個 SHA；若某 SHA 底下不存在那個路徑，改用同行其他 SHA 配對（標「配對修正」）。仍然配不到的列在最後一節，**沒有人工核對**。

## 二、引用過的 SHA

| SHA | 提交日 | 物件還在 |
|---|---|---|
| `c291e79` | 2026-09-10 | 是（完整 `c291e7961a515f6d7af9304e7fd1d257929aef26`） |
| `6b1808f` | 2026-09-17 | 是（完整 `6b1808f432adfa96ab6c2f033e158ca230422e16`） |
| `4e84901` | 2026-09-01 | 是（完整 `4e84901e6471b79ec0338099867ebb4606d12bb5`） |
| `d347e70` | 2026-09-04 | 是（完整 `d347e703908d0406b7a7ef80e3a0e594d86b2215`） |
| `0d1f500` | 2026-09-15 | 是（完整 `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`） |
| `477b4f4` | 2026-09-24 | 是（完整 `477b4f420553e8a52c2fbccc464d7561b239c443`） |
| `0a53fb5` | 2026-08-30 | 是（完整 `0a53fb55bea101816fa226bb964ae2bed71c343b`） |
| `ddefc45` | 2026-09-17 | 是（完整 `ddefc45fbc7f8e46dd73185e68295696d1297887`） |
| `c389f96` | 2026-09-08 | 是（完整 `c389f96bf3a9b6807cb71ed6bdad5849be0df6d8`） |
| `e459e32` | 2026-09-15 | 是（完整 `e459e3263733075bd806d9ba6dd92bbc4bf3983f`） |

`d347e70` 先前記錄為「與 `origin/master` 分岔」，現在是新 HEAD 的祖先，該註記（[`.docs/structured-input-survey.md`](structured-input-survey.md) 等）已過期。

## 三、總覽

| 結果 | 筆數 |
|---|---|
| 有變動 | 59 |
| 無變動 | 83 |
| 已刪除或搬走 | 1 |
| 無法歸屬 | 9 |

## 四、有變動（依變動行數由大到小）

| 對照 SHA | 路徑 | +/- | 引用位置 |
|---|---|---|---|
| `c291e79` | `packages/client/ui-workspace/src/client/navigation.ts` | +227/-51 | `apps/web/src/lib/new-conversation.ts:3` |
| `c291e79` | `packages/core/session/src/index.ts` | +132/-88 | `packages/nexus-core/src/conversation-replay.ts:8`、`packages/nexus-core/src/session-log.ts:978` |
| `c291e79` | `packages/core/session/src/repair.ts` | +148/-72 | `packages/nexus-core/src/conversation-replay.ts:39` |
| `c291e79` | `packages/api/session-controller/src/commands.ts` | +93/-59 | `packages/nexus-wire/src/protocol.ts:154` |
| `c291e79` | `packages/llm/llm/src/message.ts` | +86/-47 | `packages/nexus-core/src/logged-message.ts:8`、`packages/nexus-core/src/session-log.ts:500` |
| `c291e79` | `packages/session/session-telemetry-otel/src/index.ts` | +49/-84 | `apps/harness/src/agent-factory.ts:1003`、`packages/nexus-core/src/session-telemetry.ts:133` |
| `4e84901` | `packages/core/tools/src/index.ts` | +90/-42 | `apps/harness/src/plugin-config.ts:127`、`packages/nexus-core/src/containment.ts:18` |
| `477b4f4` | `packages/session/session-telemetry-otel/src/index.ts` | +48/-83 | `.docs/seven-layer-inventory-2026-09-26.md:746` |
| `ddefc45` | `packages/session/session-telemetry-otel/src/index.ts` | +48/-83 | `.docs/seven-layer-inventory-2026-09-26.md:746`、`.docs/seven-layer-inventory-2026-09-26.md:763` |
| `0d1f500` | `docs/event-producer-consumer.zh.md` | +73/-54 | `.docs/plugin-architecture-gap-survey.md:324` |
| `c291e79` | `packages/core/tools/src/index.ts` | +85/-36 | `packages/nexus-core/src/fs-tool-errors.ts:190`、`packages/nexus-core/src/output-schema.ts:8` |
| `ddefc45` | `packages/api/workspace-files/src/index.ts` | +44/-57 | `apps/harness/src/deliverable-files.ts:7`、`apps/harness/src/deliverable-window.ts:3`、`apps/harness/src/settings/deliverable-files.ts:30`、`packages/nexus-wire/src/deliverables.ts:52` |
| `ddefc45` | `packages/client/ui-tool/src/client/tool/models/tool-call-model.ts` | +62/-20 | `apps/web/src/lib/tool-view.ts:3` |
| `d347e70` | `packages/interaction/user-questions/src/types.ts` | +72/-0 | `packages/nexus-plugin-ask-user/src/index.ts:5` |
| `ddefc45` | `packages/core/agent-loop/src/index.ts` | +8/-60 | `.docs/seven-layer-inventory-2026-09-26.md:700` |
| `c291e79` | `packages/core/session/src/types.ts` | +47/-19 | `packages/nexus-core/src/session-log.ts:361`、`packages/nexus-core/src/session-log.ts:469`、`packages/nexus-core/src/session-log.ts:709`、`packages/nexus-core/src/session-log.ts:878` |
| `c291e79` | `packages/client/ui-chat/src/client/conversation-nodes/tool.ts` | +48/-14 | `apps/harness/src/thread-pump.ts:39` |
| `ddefc45` | `packages/core/session/src/types.ts` | +40/-17 | `.docs/seven-layer-inventory-2026-09-26.md:800`、`packages/nexus-core/src/session-store.ts:165` |
| `d347e70` | `docs/subsystems/persistence.zh.md` | +38/-17 | `packages/nexus-core/src/session-persistence.ts:5` |
| `4e84901` | `packages/spill/spill-policy/README.zh.md` | +29/-23 | `apps/harness/src/agent-factory.ts:426` |
| `c291e79` | `packages/api/session-controller/src/list.ts` | +29/-17 | `apps/harness/src/session-list.ts:4` |
| `c291e79` | `packages/api/session-controller/src/history.ts` | +26/-9 | `packages/nexus-wire/src/protocol.ts:712` |
| `ddefc45` | `packages/api/session-controller/src/history.ts` | +26/-9 | `packages/nexus-wire/src/protocol.ts:778` |
| `d347e70` | `packages/hooks/hooks-claude-code/src/index.ts` | +18/-12 | `.docs/plugin-architecture-gap-survey.md:314` |
| `c291e79` | `packages/subagent/subagent/src/child-agent.ts` | +21/-9 | `packages/nexus-core/src/subagent-delegation.ts:8` |
| `ddefc45` | `packages/client/connection/tests/browser-auth.host.spec.ts` | +25/-2 | `apps/harness/src/browser-auth.test.ts:3` |
| `0a53fb5` | `packages/core/session/src/invariant.ts` | +15/-6 | `packages/nexus-core/src/session-registry.ts:16` |
| `477b4f4` | `packages/llm/llm-pi-ai/src/catalog.ts` | +17/-4 | `apps/harness/src/model-catalog.ts:5` |
| `4e84901` | `packages/goal/goal/README.zh.md` | +10/-10 | `.docs/plugin-architecture-gap-survey.md:161` |
| `0d1f500` | `packages/compaction/compaction-basic/README.zh.md` | +10/-9 | `apps/harness/src/agent-factory.ts:511` |
| `477b4f4` | `packages/core/agent-loop/src/agent.ts` | +18/-1 | `apps/harness/src/steer.test.ts:4`、`apps/harness/src/thread-pump.ts:1093`、`apps/harness/src/thread-pump.ts:1629`、`apps/harness/src/thread-pump.ts:370`、`packages/nexus-core/src/session-log.ts:507`、`packages/nexus-core/src/step-inbox.ts:9` |
| `ddefc45` | `packages/client/connection/src/browser-auth.ts` | +8/-10 | `apps/harness/src/browser-auth.ts:10` |
| `ddefc45` | `packages/credentials/credentials-local/src/index.ts` | +0/-18 | `.docs/seven-layer-inventory-2026-09-26.md:974` |
| `ddefc45` | `packages/session/session-telemetry/src/coordinator.ts` | +10/-7 | `.docs/seven-layer-inventory-2026-09-26.md:759` |
| `4e84901` | `packages/goal/README.zh.md` | +7/-8 | `.docs/plugin-architecture-gap-survey.md:161` |
| `d347e70` | `packages/plan/plan-mode/src/index.ts` | +11/-4 | `packages/nexus-core/src/session-log.ts:643` |
| `c291e79` | `packages/core/agent-loop/src/tool-calls.ts` | +7/-7 | `packages/nexus-core/src/session-log.ts:674` |
| `477b4f4` | `packages/api/gateway/src/index.ts` | +13/-0 | `apps/harness/src/thread-feed.ts:5`、`packages/nexus-wire/src/protocol.ts:635` |
| `c291e79` | `packages/api/session-controller/src/agent.ts` | +10/-3 | `apps/harness/src/resume-guards.ts:24` |
| `0d1f500` | `packages/core/agent/src/index.ts` | +8/-5 | `.docs/plugin-architecture-gap-survey.md:324` |
| `ddefc45` | `packages/context/time-context/README.zh.md` | +6/-6 | `.docs/seven-layer-inventory-2026-09-26.md:544` |
| `ddefc45` | `packages/llm/llm/src/assembler.ts` | +5/-5 | `apps/harness/src/interrupted-reasoning.test.ts:5`、`apps/harness/src/thread-pump.ts:2033` |
| `ddefc45` | `packages/client/ui-primitives/src/markdown/parse.ts` | +5/-4 | `apps/web/src/lib/markdown/parse.ts:2` |
| `ddefc45` | `packages/deliverables/tool-present/src/index.ts` | +5/-4 | `.docs/package-coupling-audit-2026-09-26.md:443` |
| `ddefc45` | `packages/client/ui-tool/src/client/tool/models/raw-tool-call.ts` | +5/-3 | `apps/harness/src/tool-result-text.test.ts:45` |
| `c291e79` | `packages/session/session-persistence-jsonl/src/format.ts` | +5/-3 | `apps/harness/src/jsonl-session-store.ts:661` |
| `4e84901` | `packages/goal/goal-round-driver/README.zh.md` | +3/-4 | `.docs/plugin-architecture-gap-survey.md:161` |
| `6b1808f` | `packages/session/session-telemetry/src/index.ts` | +5/-2 | `packages/nexus-core/src/registry.ts:636`、`packages/nexus-core/src/session-telemetry.ts:204` |
| `0d1f500` | `packages/subagent/subagent/src/child-agent.ts` | +5/-2 | `packages/nexus-core/src/session-log.ts:617`、`packages/nexus-plugin-sandbox-policy/src/sandbox-mode.ts:39` |
| `4e84901` | `docs/subsystems/approval.zh.md` | +2/-2 | `apps/harness/src/interrupt.test.ts:324` |
| `477b4f4` | `packages/session/session-telemetry/src/coordinator.ts` | +3/-1 | `.docs/seven-layer-inventory-2026-09-26.md:759` |
| `477b4f4` | `apps/cli/package.json` | +2/-1 | `.docs/seven-layer-inventory-2026-09-26.md:909` |
| `ddefc45` | `packages/host/webserver/src/index.ts` | +2/-1 | `apps/harness/src/wire-server.ts:98` |
| `477b4f4` | `apps/cli/reference/README.zh.md` | +1/-1 | `packages/nexus-core/src/config-schema.ts:4` |
| `ddefc45` | `packages/bundle/base/README.md` | +2/-0 | `.docs/seven-layer-inventory-2026-09-26.md:1010` |
| `477b4f4` | `packages/context/time-context/README.zh.md` | +1/-1 | `.docs/seven-layer-inventory-2026-09-26.md:544` |
| `ddefc45` | `packages/credentials/authorization/README.zh.md` | +2/-0 | `.docs/seven-layer-inventory-2026-09-26.md:1010` |
| `477b4f4` | `packages/session/session-format-v3-to-v4/package.json` | +1/-1 | `.docs/seven-layer-inventory-2026-09-26.md:800` |
| `477b4f4` | `packages/boot/app-boot/README.zh.md` | +0/-1 | `.docs/development-plan.md:108`、`apps/harness/src/plugin-config-wire.test.ts:284`、`apps/harness/src/plugin-config.test.ts:602`、`apps/harness/src/plugin-config.ts:931`、`apps/harness/src/serve.ts:491`、`packages/nexus-core/src/load.ts:58` 等 7 處 |

## 五、已刪除或搬走

| 對照 SHA | 路徑 | 引用位置 |
|---|---|---|
| `e459e32` | `packages/preset/agent-presets/src/index.ts` | `packages/nexus-core/src/fold.ts:1336` |

## 六、無法歸屬（沒有人工核對）

這些路徑在行內任何一個 dsh SHA 底下都不存在。多數長得就是 dsh 的路徑（`packages/client/ui-*`），所以可能是引用當時就寫錯了路徑（檔名或副檔名不對）、或引用的是別的 SHA／已更名的檔，也可能是掃描誤配；**成因沒有逐一確認**，要用的時候要自己去 dsh 找對應檔案。

| 行內 SHA | 路徑 | 引用位置 |
|---|---|---|
| `477b4f4` | `packages/client/ui-chat/src/client/chat/ChatView.ts` | `apps/web/src/lib/steer-view.ts:9` |
| `477b4f4` | `packages/client/ui-chat/src/client/chat/StatsPills.ts` | `apps/web/src/lib/session-usage-view.ts:5` |
| `477b4f4` | `packages/client/ui-conversation/src/client/queue/QueueDock.ts` | `apps/web/src/components/queue-dock.tsx:75` |
| `ddefc45` | `packages/client/ui-deliverables/src/client/ChangedFiles.ts` | `apps/web/src/components/changes-card.tsx:4` |
| `ddefc45` | `packages/client/ui-deliverables/src/client/ReviewTab.ts` | `apps/web/src/components/changes-review.tsx:5` |
| `477b4f4` | `packages/client/ui-primitives/src/DiffBlock.ts` | `apps/web/src/lib/tool-diff.ts:6` |
| `ddefc45` | `packages/client/ui-primitives/src/markdown/katex.ts` | `apps/web/src/lib/markdown/katex.tsx:2` |
| `ddefc45` | `packages/client/ui-primitives/src/markdown/render.ts` | `apps/web/src/lib/markdown/render.tsx:2` |
| `ddefc45` | `packages/skill/tool-workspace-dependencies/README.md` | `.docs/seven-layer-inventory-2026-09-26.md:265` |

## 七、無變動

| 對照 SHA | 路徑 | 引用位置 |
|---|---|---|
| `477b4f4` | `apps/cli/src/process-shutdown.ts` | `apps/harness/src/process-shutdown.ts:4` |
| `477b4f4` | `apps/cli/src/profile-boot.ts` | `apps/harness/src/http-proxy-boot.ts:5` |
| `477b4f4` | `apps/cli/tests/lazy-search-startup.compat.spec.ts` | `apps/harness/src/serve-thread-search.test.ts:8` |
| `477b4f4` | `apps/cli/tests/process-shutdown.spec.ts` | `apps/harness/src/process-shutdown.test.ts:2` |
| `477b4f4` | `docs/cookbook/extension-cookbook.zh.md` | `.docs/seven-layer-inventory-2026-09-26.md:386` |
| `0d1f500` | `docs/cordis-primer.zh.md` | `.docs/development-plan.md:118` |
| `477b4f4` | `docs/subsystems/subagent.zh.md` | `apps/harness/src/background-subagents.ts:20`、`packages/nexus-wire/src/protocol.ts:741` |
| `477b4f4` | `packages/api/session-controller/src/commands.ts` | `packages/nexus-wire/src/protocol.ts:173`、`packages/nexus-wire/src/protocol.ts:83` |
| `477b4f4` | `packages/api/session-controller/src/index.ts` | `packages/nexus-wire/src/protocol.ts:564` |
| `477b4f4` | `packages/api/session-controller/src/list.ts` | `apps/harness/src/thread-search.ts:5`、`apps/harness/src/wire-handler.ts:343` |
| `477b4f4` | `packages/api/workspace-files/src/index.ts` | `apps/harness/src/deliverable-files.ts:29`、`packages/nexus-wire/src/deliverables.ts:89` |
| `477b4f4` | `packages/boot/app-boot/src/index.ts` | `apps/harness/src/launch-env.ts:5` |
| `477b4f4` | `packages/bundle/base/README.md` | `.docs/seven-layer-inventory-2026-09-26.md:1010` |
| `477b4f4` | `packages/bundle/headless/src/index.ts` | `apps/harness/src/cli.ts:590` |
| `ddefc45` | `packages/bundle/web-app/src/index.ts` | `apps/harness/src/serve.ts:270` |
| `ddefc45` | `packages/client/connection/tests/api-request-trust.host.spec.ts` | `apps/harness/src/request-trust.test.ts:4` |
| `477b4f4` | `packages/client/ui-conversation/src/client/input/submission-policy.ts` | `apps/web/src/lib/submit-mode.ts:5` |
| `ddefc45` | `packages/client/ui-deliverables/src/client/changes-diff.ts` | `apps/web/src/lib/changes-diff.ts:4` |
| `ddefc45` | `packages/client/ui-deliverables/src/client/changes-summary.ts` | `apps/web/src/lib/changes-summary.ts:4` |
| `c291e79` | `packages/client/ui-message-feedback/src/client/locales.ts` | `apps/web/src/lib/feedback.ts:4` |
| `ddefc45` | `packages/client/ui-primitives/src/markdown/cjkFriendlyStrong.ts` | `apps/web/src/lib/markdown/cjk-friendly-strong.ts:2` |
| `ddefc45` | `packages/client/ui-primitives/src/markdown/incremental.ts` | `apps/web/src/lib/markdown/incremental.ts:2` |
| `ddefc45` | `packages/client/ui-primitives/src/markdown/mathCompatibility.ts` | `apps/web/src/lib/markdown/math-compatibility.ts:2` |
| `477b4f4` | `packages/client/ui-session/src/client/index.ts` | `apps/web/src/lib/thread-status.ts:9` |
| `477b4f4` | `packages/compaction/compaction-basic/src/config.ts` | `.docs/seven-layer-inventory-2026-09-26.md:487` |
| `ddefc45` | `packages/context/agent-instructions/src/render.ts` | `packages/nexus-plugin-agent-instructions/src/render.test.ts:2`、`packages/nexus-plugin-agent-instructions/src/render.ts:4` |
| `477b4f4` | `packages/context/session-reference/src/index.ts` | `apps/harness/src/session-reference-candidates.ts:4` |
| `477b4f4` | `packages/context/session-reference/src/types.ts` | `packages/nexus-core/src/session-log.ts:237` |
| `477b4f4` | `packages/core/agent-loop/src/constants.ts` | `.docs/seven-layer-inventory-2026-09-26.md:700` |
| `ddefc45` | `packages/core/agent-loop/src/constants.ts` | `.docs/seven-layer-inventory-2026-09-26.md:700` |
| `477b4f4` | `packages/core/agent-loop/src/inbox.ts` | `apps/harness/src/send-queue.test.ts:4`、`apps/harness/src/thread-pump.ts:31`、`packages/nexus-core/src/inbox.test.ts:3` 等 6 處 |
| `477b4f4` | `packages/core/agent-loop/src/index.ts` | `.docs/seven-layer-inventory-2026-09-26.md:700` |
| `0d1f500` | `packages/core/agent/src/runtime-types.ts` | `.docs/plugin-architecture-gap-survey.md:324` |
| `477b4f4` | `packages/core/agent/src/runtime-types.ts` | `.docs/jev-gatekeeper-survey.md:49` |
| `477b4f4` | `packages/core/agent/src/types.ts` | `packages/nexus-core/src/session-log.ts:833` |
| `477b4f4` | `packages/core/session/src/types.ts` | `.docs/seven-layer-inventory-2026-09-26.md:800`、`packages/nexus-core/src/session-log.ts:194`、`packages/nexus-core/src/session-store.ts:183` 等 5 處 |
| `477b4f4` | `packages/core/system-prompt/src/index.ts` | `packages/nexus-plugin-system-prompt/src/index.ts:4` |
| `477b4f4` | `packages/core/tools/src/index.ts` | `packages/nexus-core/src/containment.ts:238`、`packages/nexus-core/src/subagent-tool-filter.ts:7` |
| `477b4f4` | `packages/core/tools/src/ptc.ts` | `packages/nexus-plugin-quickjs/src/index.ts:77` |
| `477b4f4` | `packages/core/tools/src/schema.ts` | `.docs/seven-layer-inventory-2026-09-26.md:386` |
| `477b4f4` | `packages/credentials/authorization/README.zh.md` | `.docs/seven-layer-inventory-2026-09-26.md:1010` |
| `ddefc45` | `packages/credentials/credentials-local/README.zh.md` | `.docs/seven-layer-inventory-2026-09-26.md:974` |
| `477b4f4` | `packages/deliverables/tool-present/src/index.ts` | `.docs/package-coupling-audit-2026-09-26.md:439`、`.docs/package-coupling-audit-2026-09-26.md:443` |
| `ddefc45` | `packages/deliverables/tool-present/src/types.ts` | `packages/nexus-core/src/deliverables.ts:5`、`packages/nexus-core/src/session-log.ts:791` |
| `477b4f4` | `packages/deliverables/workspace-changes/src/types.ts` | `packages/nexus-plugin-workspace-changes/src/types.ts:5` |
| `ddefc45` | `packages/deliverables/workspace-changes/src/types.ts` | `packages/nexus-core/src/session-log.ts:817` |
| `c291e79` | `packages/feedback/message-feedback/README.md` | `packages/nexus-plugin-feedback/src/invariant.ts:4` |
| `6b1808f` | `packages/feedback/message-feedback/src/index.ts` | `packages/nexus-core/src/feedback.ts:302` |
| `ddefc45` | `packages/feedback/message-feedback/src/types.ts` | `packages/nexus-core/src/session-log.ts:772` |
| `477b4f4` | `packages/fs/fs-local/src/fsio.ts` | `apps/harness/src/binary-read.ts:6`、`apps/harness/src/binary-tool-results.test.ts:10` |
| `477b4f4` | `packages/goal/goal-round-driver/src/index.ts` | `apps/harness/src/goal-driver.ts:129` |
| `6b1808f` | `packages/goal/goal/src/index.ts` | `packages/nexus-core/src/registry.ts:219` |
| `ddefc45` | `packages/goal/goal/src/index.ts` | `packages/nexus-plugin-goal/src/index.ts:163` |
| `477b4f4` | `packages/goal/tool-goal/src/authority.ts` | `packages/nexus-plugin-goal/src/authority.ts:62` |
| `c291e79` | `packages/interaction/commands/src/index.ts` | `packages/nexus-core/src/commands.ts:107`、`packages/nexus-core/src/session-log.ts:390` |
| `477b4f4` | `packages/llm/llm-deepseek/src/serialize.ts` | `apps/harness/src/settings/live-model.ts:111` |
| `477b4f4` | `packages/llm/llm/README.zh.md` | `.docs/seven-layer-inventory-2026-09-26.md:386` |
| `477b4f4` | `packages/llm/llm/src/error.ts` | `packages/nexus-core/src/tool-events.ts:36` |
| `477b4f4` | `packages/llm/llm/src/types.ts` | `apps/harness/src/live-model.ts:856` |
| `477b4f4` | `packages/llm/token-meter/src/usage-projection.ts` | `packages/nexus-core/src/token-usage.ts:5` |
| `477b4f4` | `packages/mcp/mcp-client/src/tools.ts` | `packages/nexus-plugin-mcp/src/project-content.ts:8` |
| `477b4f4` | `packages/mcp/mcp-client/src/transport.ts` | `packages/nexus-plugin-mcp/src/index.test.ts:320`、`packages/nexus-plugin-mcp/src/index.ts:210` |
| `477b4f4` | `packages/mcp/mcp-client/tests/fixtures/pagination-limit-server.ts` | `.docs/seven-layer-inventory-2026-09-26.md:398` |
| `477b4f4` | `packages/ptc-runtime/ptc-runtime/src/types.ts` | `packages/nexus-plugin-quickjs/src/index.ts:66` |
| `ddefc45` | `packages/sandbox/sandbox-policy/src/index.ts` | `apps/harness/src/resume-guards.ts:88`、`packages/nexus-plugin-sandbox-policy/src/index.ts:32` |
| `477b4f4` | `packages/session-query/session-query-sqlite/src/index.ts` | `apps/harness/src/settings/thread-search.ts:4` |
| `c291e79` | `packages/session/session-persistence/src/errors.ts` | `packages/nexus-core/src/session-store.ts:530` |
| `477b4f4` | `packages/session/session-stats/src/projection.ts` | `packages/nexus-wire/src/session-totals.ts:5` |
| `477b4f4` | `packages/session/session-title-llm/src/index.ts` | `packages/nexus-core/src/session-log.ts:862` |
| `477b4f4` | `packages/session/session-title/src/index.ts` | `apps/harness/src/session-title.ts:5`、`packages/nexus-wire/src/title.ts:4` |
| `477b4f4` | `packages/session/session-title/src/types.ts` | `packages/nexus-core/src/session-log.ts:847` |
| `477b4f4` | `packages/spill/spill-policy/src/index.ts` | `.docs/seven-layer-inventory-2026-09-26.md:500`、`packages/nexus-core/src/spill-policy.ts:5` |
| `477b4f4` | `packages/subagent/tool-subagent/src/index.ts` | `apps/harness/src/background-delegation.ts:8`、`apps/harness/src/model-selection-policy.ts:5`、`apps/harness/src/settings/background-subagents.ts:6` |
| `477b4f4` | `packages/subagent/tool-subagent/src/model-selection-state.ts` | `packages/nexus-core/src/session-log.ts:655` |
| `477b4f4` | `packages/subprocess/subprocess/src/index.ts` | `packages/nexus-core/src/child-env.ts:3` |
| `477b4f4` | `packages/util/code-language/src/index.ts` | `packages/nexus-core/src/code-language.ts:4` |
| `ddefc45` | `packages/util/home-paths/src/index.ts` | `apps/harness/src/harness-home.ts:5` |
| `477b4f4` | `packages/util/http-proxy/src/install.ts` | `packages/nexus-core/src/http-proxy/install.ts:5` |
| `477b4f4` | `packages/util/http-proxy/src/policy.ts` | `packages/nexus-core/src/http-proxy/policy.ts:5` |
| `477b4f4` | `packages/util/http-proxy/tests/install.spec.ts` | `packages/nexus-core/src/http-proxy/install.test.ts:3` |
| `477b4f4` | `packages/util/http-proxy/tests/policy.spec.ts` | `packages/nexus-core/src/http-proxy/policy.test.ts:3` |
| `ddefc45` | `packages/util/timeout/src/index.ts` | `packages/nexus-core/src/session-persistence.ts:315` |
| `477b4f4` | `scripts/verify-no-bare-dispatcher.ts` | `apps/harness/src/no-bare-dispatcher.test.ts:3` |

## 八、Proteus

`references/Proteus/proteus/adapters/dsh.py`（引用 SHA `962304b3`，見 [`plugin-architecture-gap-survey.md`](plugin-architecture-gap-survey.md)）在 `962304b3` 與新 HEAD `0d37763` 之間**沒有變動**，引用仍成立。

`references/Proteus-fork` 的 `adapter/nexus` 已 rebase 到最新 `origin/main`（15 個 commit，領先 15、落後 0；唯一衝突是 `proteus/cli.py` 的 `--adapter` 說明文字，合成 `minimal, llm, dsh, pi, codex, aki, nexus`）。舊分支備份在本機 tag `backup/adapter-nexus-pre-rebase-20261001`（只在本機）。

## 九、重跑方式

這份清單由一支一次性腳本產生，不在版控裡；要重產就是重做同樣的掃描：從本 repo 取出「同一行有 dsh SHA 與 `packages/…`／`docs/…` 路徑」的引用，各自對 `git -C references/deepseek-harness diff --numstat <SHA> HEAD -- <路徑>`。
