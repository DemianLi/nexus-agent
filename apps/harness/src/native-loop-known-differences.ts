/**
 * native agent loop 的已知差異（[#2356](https://github.com/DemianLi/nexus-agent/issues/2356)）：同一套測試在 `vitest.native.config.ts` 下
 * 跑，這些條照登記的方式跑（`native-loop.runner.ts`）。每一條都歸到一種差異，每一種都寫出根因與卡；不在這裡的，兩個 loop 要一樣。
 *
 * 多數種類是要收掉的，卡是收掉它的那張。`byDesign` 的那幾種是設計如此、不收，卡是定下這件事的那張。
 *
 * @module
 */

/** 差異的種類。 */
export type KnownDifferenceKind = keyof typeof KNOWN_DIFFERENCE_KINDS;

/** 一種差異的根因與卡。 */
export interface KnownDifferenceKindInfo {
  readonly card: number;
  readonly reason: string;
  /** 設計如此、不收：`card` 是定下這件事的卡，不是收掉它的卡。 */
  readonly byDesign?: true;
}

export const KNOWN_DIFFERENCE_KINDS = {
  noHumanInput: {
    card: 2358,
    byDesign: true,
    reason:
      'native 的 invoke／stream 沒人可問：呼叫上放的是 `NO_HUMAN_INPUT`，核准閘門走沒有管道那一格，工具的 `exec.interrupt` 以 ' +
      '`HumanInputUnavailable` 拒絕，也不收 resume。中斷與接回只走帶 thread 的 streamEvents（serve）。這一條用 invoke 或 stream ' +
      '斷言中斷、接回或停在核准點；前景子代理那一層跟 root 同一份 `NO_HUMAN_INPUT`。同一組能力走 streamEvents 的涵蓋：`native-loop-assembly.test.ts`、' +
      '`human-input-producers-wire.test.ts` 與各支 `*-wire.test.ts`。',
  },
  rawInterrupt: {
    card: 2608,
    reason:
      '這一條的工具本體直接呼叫 LangGraph 的 `interrupt()`，不經 `exec.interrupt`，也不經等人服務。native 沒有圖可以接住它再接回。',
  },
  checkpoint: {
    card: 2360,
    reason:
      '這一條斷言 LangGraph 的存檔點：直接讀 `checkpointer.getTuple`、另一個 agent 實例經同一個 saver 接同一條 thread，' +
      '或存檔點寫入時的 seal 與層數守衛（#1658）。native 的 state 在實例的記憶體裡，不寫存檔點。',
  },
  langgraphInternals: {
    card: 2363,
    reason:
      "這一條斷言 LangGraph 本身的東西：編好的圖的節點（`graph.nodes`，native 不編圖）或 `streamMode: 'messages'`" +
      '（native 的 `stream()` 只做 updates 與 values）。',
  },
  turnStoppingStep: {
    card: 2363,
    reason:
      '這一條斷言 `agent/turn-stopping` 的 `step`：langgraph 下由轉接格（`turn-stopping.ts`）派，拿不到步數，step 給 0；' +
      'native 給真的步數。到 #2363 拿掉。',
  },
  unregisteredCell: {
    card: 2363,
    reason:
      '這一條掛了一顆沒登記一步的格：基座（deepagents）原版的 `SummarizationMiddleware`（同名取代），或不 import core、' +
      '直接寫 `wrapModelCall` 的 `.mjs` 插件。native 建構時就拋（`packages/nexus-core/src/native-loop/agent.ts` 的建構檢查）；' +
      '出貨組裝沒有這種組法（`native-shipped-cells.test.ts`）。',
  },
} as const satisfies Record<string, KnownDifferenceKindInfo>;

/** 一條登記：哪個檔的哪一條（`describe > … > it`，同 vitest 報告），哪一種差異，native 下怎麼跑。 */
export interface KnownDifference {
  readonly file: string;
  readonly test: string;
  readonly kind: KnownDifferenceKind;
  /**
   * `fails`：照跑、要失敗才算過；`skip`：不跑（懸住之後會漏到同檔下一條的）；`passes`：照跑、要過，差異在斷言之外。
   */
  readonly run: 'fails' | 'skip' | 'passes';
}

export const KNOWN_DIFFERENCES: readonly KnownDifference[] = [
  {
    file: 'src/agent-factory.test.ts',
    test: 'createNexusAgent > 宣告了要核准的工具、也給了 checkpointer 時中斷得起來',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/approval-gate-order.test.ts',
    test: '核准 waterfall 的順序決定紀錄有沒有被人看過就寫出去 > control：只有 submit-record',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/approval-gate-order.test.ts',
    test: '核准 waterfall 的順序決定紀錄有沒有被人看過就寫出去 > mcp-first：一列 MCP 的閘門排在 submit-record 之前',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/approval-gate-order.test.ts',
    test: '核准 waterfall 的順序決定紀錄有沒有被人看過就寫出去 > submit-first：同一組人，只把順序對調',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/ask-user-on-tree.test.ts',
    test: 'D：樹上那一列停用，開著的 thread 照舊答得出來，下一條才看到新的 > 中斷掛著時停用 ask-user：續答照樣回到工具手上；之後開的 thread 沒有這顆工具',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/ask-user-on-tree.test.ts',
    test: 'E：答題管道由入口決定，每個入口各一條，沒有樹的呼叫端也一樣 > serve 那一格（有人在）：問題發出去，停在中斷上，酬載帶 question 判別式',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/ask-user-on-tree.test.ts',
    test: 'E：答題管道由入口決定，每個入口各一條，沒有樹的呼叫端也一樣 > 同一棵樹上兩條 thread（serve 的形狀）：各自停在自己的中斷上，互不串線',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/ask-user-on-tree.test.ts',
    test: 'E：答題管道由入口決定，每個入口各一條，沒有樹的呼叫端也一樣 > 沒有樹的呼叫端：同一個行程裡兩份無樹組裝（一份 headless、一份有人在）各有各的答題管道',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/assembly-parity.test.ts',
    test: '自有組裝點對上 createDeepAgent > 同一份 fold 產物：每一次送給模型的請求、綁定的工具、圖的節點都逐位元組相同',
    kind: 'langgraphInternals',
    run: 'fails',
  },
  {
    file: 'src/attachment-slash-wire.test.ts',
    test: 'slash.run 帶附件 > handler 經 steer 傳帶型別以外鍵的參照（#2323）：日誌照記，送進圖的那則訊息只留型別裡的欄位',
    kind: 'checkpoint',
    run: 'fails',
  },
  {
    file: 'src/attachment-wire.test.ts',
    test: '內嵌的圖 > 送上線的是 image_url（位元組與原圖一致）；base64 不進日誌、不進存檔點',
    kind: 'checkpoint',
    run: 'fails',
  },
  {
    file: 'src/background-delegation.test.ts',
    test: '背景路徑上的 #326：沙箱快照 > 子代理要核准的操作：前景改派問人，背景 start 回絕 > 前景改派：root 停在子代理冒出來的核准上，沒有自動拒絕',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/checkpoint-serde.test.ts',
    test: '續接：日誌裡的舊事件比上限深（#1658） > 參數 3000 層（原本的無聲區）：thread 建不起來，wire 碼是 thread_history_too_deep，訊息帶 checkpoint_depth_exceeded、seq 與層數',
    kind: 'checkpoint',
    run: 'fails',
  },
  {
    file: 'src/checkpoint-serde.test.ts',
    test: '續接：日誌裡的舊事件比上限深（#1658） > 參數 5000 層（原本 decirc 先爆）：thread 建不起來，wire 碼是 thread_history_too_deep，訊息帶 checkpoint_depth_exceeded、seq 與層數',
    kind: 'checkpoint',
    run: 'fails',
  },
  {
    file: 'src/cli.test.ts',
    test: '停在核准點的那一輪 > 印出停在哪、還沒跑的是什麼、以及這個入口按不了核准',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/compaction-log.test.ts',
    test: '壓縮發生時，日誌裡留得下來 > `filePath` 指到的檔真的寫出來了',
    kind: 'checkpoint',
    run: 'fails',
  },
  {
    file: 'src/conversation-history-route.test.ts',
    test: '摘要器的歷史（read-only） > 不落進工作區，下一輪讀得回來',
    kind: 'checkpoint',
    run: 'fails',
  },
  {
    file: 'src/conversation-history-route.test.ts',
    test: '摘要器的歷史（workspace-write） > 不落進工作區，下一輪讀得回來',
    kind: 'checkpoint',
    run: 'fails',
  },
  {
    file: 'src/conversation-history-route.test.ts',
    test: '超大 human message（read-only） > 搬去的地方不在工作區，模型只收到佔位，原話下一輪讀得回來',
    kind: 'checkpoint',
    run: 'fails',
  },
  {
    file: 'src/conversation-history-route.test.ts',
    test: '超大 human message（workspace-write） > 搬去的地方不在工作區，模型只收到佔位，原話下一輪讀得回來',
    kind: 'checkpoint',
    run: 'fails',
  },
  {
    file: 'src/conversation-restore-share.test.ts',
    test: '層數：讀盤記下的夠淺就不再量，其餘照舊量 > 舊日誌的事件 601 層、最深那格帶 `lc` 鍵（上限再多 1 層）：照舊量、照舊拒，錯誤帶 seq',
    kind: 'checkpoint',
    run: 'fails',
  },
  {
    file: 'src/conversation-restore-share.test.ts',
    test: '層數：讀盤記下的夠淺就不再量，其餘照舊量 > 舊格式：只有 `additional_kwargs.tool_calls` 的參數字串，事件很淺，解析出來超過上限：照舊量、照舊拒',
    kind: 'checkpoint',
    run: 'fails',
  },
  {
    file: 'src/conversation-restore-share.test.ts',
    test: '巢狀的值與讀盤的日誌共用 > 經真的 updateState 寫進去：巢狀的值就是日誌那一份（同一個物件），沒有 id 的那則補上了 id，整則凍過',
    kind: 'checkpoint',
    run: 'fails',
  },
  {
    file: 'src/interrupt.test.ts',
    test: '一批裡混著核准與拒絕 > **一個被拒不再拖累另一個**——被核准的那個真的跑了',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/interrupt.test.ts',
    test: '一批裡混著核准與拒絕 > **一顆拒絕蓋住同一輪的兩顆呼叫**——兩個都沒跑，各拿各的拒絕（上一條的反面）',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/interrupt.test.ts',
    test: '一批裡混著核准與拒絕 > 兩個都核准 → 兩個都跑（下一條的對照組）',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/interrupt.test.ts',
    test: '一批裡混著核准與拒絕 > 兩個都要核准 → 一次暫停帶一顆中斷（逐顆問），一個決定套到兩顆上',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/interrupt.test.ts',
    test: '核准之後 > 拒絕 → 工具沒跑，模型收到一則 error 的 ToolMessage',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/interrupt.test.ts',
    test: '核准之後 > 核准 → 工具真的跑了（上一條的對照組）',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/interrupt.test.ts',
    test: '閘門本身的邊界 > **`context.interruptOn` 那條繞道失效了**——那正是換機制要換掉的東西',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/interrupt.test.ts',
    test: '閘門本身的邊界 > **listener 看得到工具名與已解析的參數**——`when` 述詞因此是免費的',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/interrupt.test.ts',
    test: '閘門本身的邊界 > resume 傳看不懂的決定 → **一則錯誤，不是靜默降級成核准，也不會殺掉整場 run**',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/interrupt.test.ts',
    test: 'subagent 裡的閘門 > worker：呼叫 gated 工具 → 中斷冒到 root，工具還沒跑；核准 → 工具真的跑、root 收尾',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/interrupt.test.ts',
    test: 'subagent 裡的閘門 > worker：拒絕 → 只拒那一次，工具沒跑，子代理收到拒絕、照常收尾，root 的 task 完成',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/interrupt.test.ts',
    test: 'subagent 裡的閘門 > general-purpose：呼叫 gated 工具 → 中斷冒到 root，工具還沒跑；核准 → 工具真的跑、root 收尾',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/interrupt.test.ts',
    test: 'subagent 裡的閘門 > general-purpose：拒絕 → 只拒那一次，工具沒跑，子代理收到拒絕、照常收尾，root 的 task 完成',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/invalid-tool-args.test.ts',
    test: '核准卡跨組裝續接 > 第一場停在壞參數工具的核准卡上，第二場核准：本體零次、拿到 INVALID_ARGS',
    kind: 'checkpoint',
    run: 'fails',
  },
  {
    file: 'src/invalid-tool-args.test.ts',
    test: '要核准的工具 > 拒絕就是一般的拒絕',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/invalid-tool-args.test.ts',
    test: '要核准的工具 > 核准之後拿到 INVALID_ARGS',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/legacy-thread-escalation.test.ts',
    test: '舊 thread 對守衛擋的目標升級：不掛核准卡（#2078） > 反例：根目錄別的檔、子目錄裡的指示檔名、名字像技能來源的目錄：照舊掛核准卡',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/mcp-migration.test.ts',
    test: 'MCP 工具的定義、結果、中斷與日誌，與對照組逐字相同',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/measure/cordis-1386/compat.test.ts',
    test: '相容層讓出貨清單原樣跑（#1386 ②） > CLI 清單：請求、工具、middleware、命令逐位元組相同',
    kind: 'langgraphInternals',
    run: 'fails',
  },
  {
    file: 'src/measure/cordis-1386/compat.test.ts',
    test: '相容層讓出貨清單原樣跑（#1386 ②） > serve 清單：請求、工具、middleware、命令逐位元組相同',
    kind: 'langgraphInternals',
    run: 'fails',
  },
  {
    file: 'src/measure/old-thread-disposal.test.ts',
    test: '仍在用舊版插件的 thread > 問題 1：header 的插件清單分得出誰用哪一版；線上的列表分不出',
    kind: 'unregisteredCell',
    run: 'fails',
  },
  {
    file: 'src/measure/old-thread-disposal.test.ts',
    test: '仍在用舊版插件的 thread > 問題 2a：取消之後那一輪正常收尾，關機不再動日誌',
    kind: 'unregisteredCell',
    run: 'fails',
  },
  {
    file: 'src/measure/old-thread-disposal.test.ts',
    test: '仍在用舊版插件的 thread > 問題 2b：取消之後同一條 thread 照收新輸入，而且照用 v1',
    kind: 'unregisteredCell',
    run: 'fails',
  },
  {
    file: 'src/measure/old-thread-disposal.test.ts',
    test: '仍在用舊版插件的 thread > 問題 2c：不取消直接關機，日誌停在進行中的那一輪，仍讀得完',
    kind: 'unregisteredCell',
    run: 'fails',
  },
  {
    file: 'src/measure/old-thread-disposal.test.ts',
    test: '仍在用舊版插件的 thread > 問題 3：換成 v2 之後 resume，走的是 v2、歷史完整；header 不更新，另記的 session/resumed 才是現在',
    kind: 'unregisteredCell',
    run: 'fails',
  },
  {
    file: 'src/plan-mode-migration.test.ts',
    test: 'exit_plan_mode 的定義、結果、中斷與日誌，與對照組逐字相同',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/plan-mode.test.ts',
    test: 'exit_plan_mode 的結局 > 停在一顆提問上：計劃全文在 detail，intent 指得到那顆呼叫，沒有核准',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/plan-mode.test.ts',
    test: 'exit_plan_mode 的結局 > 同意 → 工具成功；plan/mode 落在工具結果之後、下一步回覆之前；下一步沒有指引',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/plan-mode.test.ts',
    test: 'exit_plan_mode 的結局 > 同意與繼續規劃都選了 → 拒絕、模式留著',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/plan-mode.test.ts',
    test: 'exit_plan_mode 的結局 > 熱續與冷續接（同意）→ 進模型請求時帶 name，供應商側位元組不變',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/plan-mode.test.ts',
    test: 'exit_plan_mode 的結局 > 熱續與冷續接（繼續規劃）→ 進模型請求時帶 name，供應商側位元組不變',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/plan-mode.test.ts',
    test: 'exit_plan_mode 的結局 > 選了同意但也寫了字 → 拒絕、模式留著',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/plan-mode.test.ts',
    test: 'exit_plan_mode 的結局 > 選繼續規劃、寫了意見 → 拒絕、模式留著',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/plan-mode.test.ts',
    test: 'exit_plan_mode 的結局 > 選繼續規劃、沒寫意見 → 拒絕、模式留著',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/plan-mode.test.ts',
    test: 'exit_plan_mode 的結局 > 關掉這一題 → 成功結果、只有一次模型呼叫，模式留著，這一輪沒有被中止',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/plan-mode.test.ts',
    test: 'exit_plan_mode 的結局 > 關掉這一題、next-step 是空的 → 收，並且關了窗（finish 叫一次）',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/plan-mode.test.ts',
    test: 'exit_plan_mode 的結局 > 關掉這一題、但 next-step 還有一件輸入 → 這一輪繼續，第二次呼叫讀到那件輸入',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/plan-mode.test.ts',
    test: 'exit_plan_mode 的結局 > 關掉這一題、同一批還有別的工具（exit_plan_mode 在前）→ 不擲、這一輪照常繼續',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/plan-mode.test.ts',
    test: 'exit_plan_mode 的結局 > 關掉這一題、同一批還有別的工具（exit_plan_mode 在後）→ 不擲、這一輪照常繼續',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/read-containment-tools.test.ts',
    test: '經往外指的符號連結讀：工具回錯誤、內容不進日誌 > submit_record 經連結讀表頭（readRaw）：表頭不進日誌',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/sandbox-escalation-migration.test.ts',
    test: 'request_sandbox_escalation 的定義、結果、中斷與日誌，與對照組逐字相同',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/sandbox-escalation.test.ts',
    test: '升級 > fail-closed 的每個出口各有各的話 > 五條出口的話兩兩不同：不加寬／被拒／關掉了人工核准／沒有 checkpointer／沒提供核准管道',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/sandbox-escalation.test.ts',
    test: '升級 > fail-closed 的每個出口各有各的話 > 回覆看不懂（不是 approve 也不是 reject）：不發 grant，拒絕帶 APPROVAL_INVALID_REPLY（#2027）',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/sandbox-escalation.test.ts',
    test: '升級 > fail-closed 的每個出口各有各的話 > 核准政策 never（有人在）：不發核准卡、不發 grant，說的是「政策是不問」；切回 ask 之後同一個請求就問人',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/sandbox-escalation.test.ts',
    test: '升級 > fail-closed 的每個出口各有各的話 > 被拒：不發 grant，同一個檔下一顆照樣被擋',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/sandbox-escalation.test.ts',
    test: '升級 > 一次核准只蓋一次呼叫 > copy_file（#2289）：唯讀下被擋、接升級指引；核准後換來源對不上，原樣重試才過得去',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/sandbox-escalation.test.ts',
    test: '升級 > 一次核准只蓋一次呼叫 > grant 只蓋指名的那個檔：別的檔照樣被擋，而且沒把 grant 吃掉',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/sandbox-escalation.test.ts',
    test: '升級 > 一次核准只蓋一次呼叫 > read-only：被擋 → 升級 → 核准 → 第一顆過得去、第二顆又被擋，session 的模式沒動',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/sandbox-escalation.test.ts',
    test: '升級 > 一次核准只蓋一次呼叫 > 升級的 file_path 不帶前置斜線也對得上：比對的是 canonical 位置，不是字串',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/sandbox-escalation.test.ts',
    test: '升級 > 一次核准只蓋被擋下的那一次操作 > edit_file：新字串不同 → 被擋；原樣 → 過得去',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/sandbox-escalation.test.ts',
    test: '升級 > 一次核准只蓋被擋下的那一次操作 > submit_record（ro-7 那一筆）：升級之後重試把欄位改掉 → 人按了核准也寫不進去',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/sandbox-escalation.test.ts',
    test: '升級 > 一次核准只蓋被擋下的那一次操作 > write_file：重試改了內容 → 被擋、grant 沒被吃掉；原樣再來一次 → 過得去',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/sandbox-escalation.test.ts',
    test: '升級 > 不加寬的請求不問人 > 反例：真的加寬的請求會掛出核准卡，人看得到是哪一個檔與理由',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/sandbox-escalation.test.ts',
    test: '升級 > 核准在工具本體裡，閘門怎麼排都跳不過 > 寬鬆閘門排在前面：照樣停在升級的核准上，grant 還沒發',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/shared-workspace-grants.test.ts',
    test: '/shared 不接受 grant > 共用區 /shared/x.txt 同一串動作（升級填 訊息裡的 backend 內位址 /x.txt）：寫不進去，兩邊磁碟都沒有新檔',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/shared-workspace-grants.test.ts',
    test: '/shared 不接受 grant > 對照：私有根 /own.txt 走完整條——發卡、核准、原樣重試寫得進去',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/shared-workspace-grants.test.ts',
    test: '對唯讀共用區升級：不掛核准卡，直接說明不能升級（#1800） > 反例：前綴長得像但不在共用區底下（/sharedx.txt）、私有根的 /own.txt：照舊掛核准卡',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/spike/spike-agent.test.ts',
    test: "Phase 0 spike：最小 deep agent > streamMode: 'messages' 收得到逐 token 的 chunk",
    kind: 'langgraphInternals',
    run: 'fails',
  },
  {
    file: 'src/subagent-delegation-claim.test.ts',
    test: '前景子代理的委派聲明跟閘門一致（#2056） > serve 路徑、政策 never：政策拒，聲明講自動拒絕',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/subagent-delegation-claim.test.ts',
    test: '前景子代理的委派聲明跟閘門一致（#2056） > 反例：serve 路徑、政策 ask：掛核准卡，聲明講等使用者',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/subagent-delegation-claim.test.ts',
    test: '前景子代理的委派聲明跟閘門一致（#2056） > 同一輪裡切到 never：下一次模型呼叫就換句，閘門也跟著拒',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/subagent-sandbox.test.ts',
    test: '子代理的沙箱模式 > root 手上一顆沒用掉的 grant：子代理同檔同操作認領不到，root 之後照樣認領得到',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/subagent-sandbox.test.ts',
    test: '子代理的沙箱模式 > root 被擋 → 子代理被擋 → root 升級：grant 綁的是 root 那一次，root 的重試過得去',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/submit-record-mounts.test.ts',
    test: 'submit_record 寫進去的，就是 read_file 與 present 看得到的 > 另一個路由前綴（工具結果暫存）也一樣',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/submit-record-mounts.test.ts',
    test: 'submit_record 寫進去的，就是 read_file 與 present 看得到的 > 對照：沒被路由的路徑，給了 --workspace 就落在磁碟上',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/submit-record-mounts.test.ts',
    test: 'submit_record 寫進去的，就是 read_file 與 present 看得到的 > 沒給 --workspace：同一條路徑，read_file 讀得到那一列',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/submit-record-mounts.test.ts',
    test: 'submit_record 寫進去的，就是 read_file 與 present 看得到的 > 給了 --workspace：路由到 state 的那一格，三顆工具看到的是同一個地方',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/submit-record-on-tree.test.ts',
    test: 'E：同一棵樹上多條 thread 同時活著，每一次呼叫靠 thread_id 認出主人 > 兩條 serve thread 共用同一個工作區、fence 相反（第一條可寫、第二條唯讀）：各用各的 fence，檔案只有可寫那條寫得進去',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/submit-record-on-tree.test.ts',
    test: 'E：同一棵樹上多條 thread 同時活著，每一次呼叫靠 thread_id 認出主人 > 兩條 serve thread 共用同一個工作區、fence 相反（第一條是唯讀、第二條可寫）：各用各的 fence，檔案只有可寫那條寫得進去',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/submit-record-on-tree.test.ts',
    test: 'E：同一棵樹上多條 thread 同時活著，每一次呼叫靠 thread_id 認出主人 > 兩條 serve thread（root 形狀）各有自己的工作區，交錯跑，檔案互不串線',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/submit-record-on-tree.test.ts',
    test: 'E：同一棵樹上多條 thread 同時活著，每一次呼叫靠 thread_id 認出主人 > 同一條 thread id 重組（舊的那份沒收）之後照樣找得到新的，舊的遲到的拆線只撤自己',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/submit-record-on-tree.test.ts',
    test: 'E：同一棵樹上多條 thread 同時活著，每一次呼叫靠 thread_id 認出主人 > 樹上那一列停用（變更紀錄）：停在核准卡上的那條 thread 照舊寫得進自己的工作區，下一條沒有這顆工具',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/submit-record-on-tree.test.ts',
    test: '三個入口各有一條（拿掉任一入口的接線要紅） > 沒有樹的呼叫端：同一個行程裡兩份無樹組裝（同一個 thread id、各自的工作區）各用各的 backend，互不相見',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/submit-record-on-tree.test.ts',
    test: 'E：同一棵樹上多條 thread 同時活著，每一次呼叫靠 thread_id 認出主人 > 第二條 thread 活著時，同步子代理（task）叫的 submit_record 寫進這條 thread 自己的工作區',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/submit-record-sandbox.test.ts',
    test: 'submit_record 被 fence 擋下 > read-only 下核准之後被擋：`isError` 帶 `FS_SANDBOX_DENIED`，模型看到的字不變',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/submit-record-sandbox.test.ts',
    test: 'submit_record 被 fence 擋下 > 對照：workspace-write 下同一顆寫得進去，日誌上是成功',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/submit-record-sandbox.test.ts',
    test: 'submit_record 被 fence 擋下 > 對照：同一個 read-only、同一顆工具的另一種失敗（欄名對不上表頭）是錯誤但**不帶碼**',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/summarization.test.ts',
    test: 'deny 規則擋得住工具，擋不住 offload > 經 offload 寫同一個路徑：規則形同不存在，歷史照樣落檔',
    kind: 'unregisteredCell',
    run: 'fails',
  },
  {
    file: 'src/summarization.test.ts',
    test: 'fraction 型別的門檻在我們的模型上是壞的 > fraction keep 一則逐字訊息都不留，而且每輪重新摘要一次',
    kind: 'unregisteredCell',
    run: 'fails',
  },
  {
    file: 'src/summarization.test.ts',
    test: 'fraction 型別的門檻在我們的模型上是壞的 > fraction trigger 連 0.01% 都碰不到——一次都沒觸發',
    kind: 'unregisteredCell',
    run: 'fails',
  },
  {
    file: 'src/summarization.test.ts',
    test: 'fraction 型別的門檻在我們的模型上是壞的 > 對照：兩邊都用 messages 就正常',
    kind: 'unregisteredCell',
    run: 'fails',
  },
  {
    file: 'src/summarization.test.ts',
    test: 'offload 失敗是 fail-open > fence 擋住的時候歷史消失，但對話照樣走完',
    kind: 'unregisteredCell',
    run: 'fails',
  },
  {
    file: 'src/summarization.test.ts',
    test: 'offload 失敗是 fail-open > 可寫的時候歷史真的落檔',
    kind: 'unregisteredCell',
    run: 'fails',
  },
  {
    file: 'src/summarization.test.ts',
    test: 'read-only 的逃生口：摘要器的 backend 是獨立的一格 > 唯讀根一個檔案都沒多，歷史落在另一個根裡，對話照樣走完',
    kind: 'unregisteredCell',
    run: 'fails',
  },
  {
    file: 'src/summarization.test.ts',
    test: '同名取代是唯一的縫 > stack 裡只有一個 SummarizationMiddleware，而且是我們的',
    kind: 'unregisteredCell',
    run: 'fails',
  },
  {
    file: 'src/summarization.test.ts',
    test: '同名取代是唯一的縫 > 註冊點只蓋到 root，記號不會外溢到 subagent 那輪',
    kind: 'unregisteredCell',
    run: 'fails',
  },
  {
    file: 'src/summarization.test.ts',
    test: '壓縮前先剪掉過大的工具結果 > 拔掉剪刀（換成基座原版摘要器）就多一次模型呼叫',
    kind: 'unregisteredCell',
    run: 'fails',
  },
  {
    file: 'src/summarization.test.ts',
    test: 'subagent 自帶的 middleware 到得了那個 subagent > 記號只出現在 subagent 那一輪，root 的兩輪都沒有',
    kind: 'unregisteredCell',
    run: 'fails',
  },
  {
    file: 'src/summarization.test.ts',
    test: '我們配的那份打底到每個 subagent > subagent 自帶一個同名的，贏的是它',
    kind: 'unregisteredCell',
    run: 'fails',
  },
  {
    file: 'src/todo-on-tree.test.ts',
    test: 'E：同一棵樹上多條 thread 同時活著，每一次呼叫靠 thread_id 認出主人 > 第二條 thread 活著時，問答中斷（ask_user_question）之後 resume 的那一次呼叫，仍寫進自己的日誌',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/todo-on-tree.test.ts',
    test: 'E：同一棵樹上多條 thread 同時活著，每一次呼叫靠 thread_id 認出主人 > 第二條 thread 活著時，核准中斷（閘門問了人）之後 resume 的那一次呼叫，仍寫進自己的日誌',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/tool-barrier.test.ts',
    test: '同一步的獨佔屏障（#711 第 2 步） > 核准中斷（PM 2026-10-08 在 #711 拍板的第 3 條） > 一次一顆卡：b 中斷時 c 什麼都不做（閘門沒看過它），逐顆答完，ToolMessage 仍照 tool_calls 的順序',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/tool-events.test.ts',
    test: 'ask_user_question > 人放棄整組 → ASK_CANCELLED，碼走得過工具本體回的那則訊息',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/tool-events.test.ts',
    test: '被核准閘門中斷的呼叫 > 拒絕：暫停時一顆呼叫，resume 之後同一個 callId 再一對',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/tool-events.test.ts',
    test: '被核准閘門中斷的呼叫 > 核准：暫停時一顆呼叫，resume 之後同一個 callId 再一對',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/tool-pipeline-product.test.ts',
    test: '拒絕在問人之前 > 對照：沒有人拒絕時，同一顆 `danger` 照舊停在核准卡（核准沒被動到）',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/tool-timeout.test.ts',
    test: '工具超時 > 對照組四之一：核准點上人想得比預算久，工具照樣正常做完',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/tool-timeout.test.ts',
    test: '工具超時 > 對照組四之二：核准後真的超時了，回報的數字不含人想的那 700ms',
    kind: 'noHumanInput',
    run: 'fails',
  },
  {
    file: 'src/validation.test.ts',
    test: '圍堵與核准的交界 > **中斷不會被吃掉**——停得下來，也接得回去',
    kind: 'rawInterrupt',
    run: 'fails',
  },
  {
    file: 'src/workspace-changes.test.ts',
    test: '擷取的時點與一輪停在哪 > langgraph 下轉接格派的 step 是 0',
    kind: 'turnStoppingStep',
    run: 'fails',
  },
];
