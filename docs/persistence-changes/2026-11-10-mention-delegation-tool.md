---
description: "記錄一次持久化型別轉換與它的相容性確認。"
kind: persistence-change
---

# 2026-11-10-mention-delegation-tool

## 摘要

會話格式 55 → 56（#2649）：`turn/start`（`kind: 'message'`）與 `inbox/spliced` 裡 `QueuedInput` 的 `mention` 多一格選填的 `tool: 'task' | 'subagent'`，記收下點名那一刻 root 的模型手上的委派工具；送進模型的點名提示照它組字，重放讀同一格。`SessionHeader` 與 `JsonlHeaderLine` 的 `version` 字面量從 55 變 56。

## 目錄

- [聲明](#declaration)
- [相容性](#compatibility)
- [驗證](#verification)
- [開發備註](#dev-note)

<a id="declaration"></a>
## 聲明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-10-mention-delegation-tool
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-11-08-request-snapshot-before-model-start"
    after: "831805cd4c3a07e320f07a7006def3dabb87eab6bc31d0811e0d29ce93adc039"
    decision: version-bump
  - root: "SessionHeader"
    previous: "2026-11-08-request-snapshot-before-model-start"
    after: "2e881995dc8fcd62174e7b1c3654014df0cebd9c638074f25f41e5a9ea762854"
    decision: version-bump
  - root: "event:inbox/spliced"
    previous: "2026-11-03-embed-profile-page-context"
    after: "54701af63be8855e21f69b7b3ada2940c6d4419b0e510bcc4f6f2cf1a90f4a9e"
    decision: version-bump
  - root: "event:turn/start"
    previous: "2026-11-03-embed-profile-page-context"
    after: "396e48cc21e51be749fd2f084515c5467ec7f6d8f24b143ea2a311316c5f99c7"
    decision: version-bump
```

<a id="compatibility"></a>
## 相容性

升版，不同版：新增的是選填欄位，但它左右續接之後的行為。55 的讀方讀到新檔會略過 `tool`，重放時照 `task` 的字組提示，背景續行模式下那則人話跟當初送出的不同、而且指向模型手上沒有的工具，沒有任何東西報錯，所以要讓 55 以格式太新拒讀。56 的讀方讀 55 以前的檔：`mention` 沒有 `tool` 時照 `task` 的字組提示，與當初送出的逐位元組相同；輪中插話落盤在 `user/message` 內容裡的舊提示字，歷史與搜尋照樣認得、剝掉並讀回點名。沒點名的訊息與以前位元組相同。回滾：被 56 碰過的 thread，55 打不開。

<a id="verification"></a>
## 驗證

`packages/nexus-core/src/subagent-mention.test.ts`：舊日誌（55 的 `turn/start` 原樣一行）重放出來的人話，與 #2359 實機重跑當時送出的原文逐位元組相同；`task`／`subagent` 兩種新日誌，live（`turnStartMessage`）、插話（`userContent`）與重放組出同一段字。`apps/harness/src/subagent-mention-wire.test.ts`：one-shot 與 continuable 兩種組裝下，`run.start` 的點名提示只提 root 手上的工具，`turn/start.mention.tool` 記下它。`apps/harness/src/subagent-mention-pump.test.ts`：舊字與 `subagent` 的字在歷史裡都剝得掉、泡泡帶點名。`apps/harness/src/session-format-fixtures.test.ts`：v0.6.1（格式 55）寫入器實際寫出的點名夾具 `v55`，今天重放出來的人話與 55 自己重放出來的逐位元組相同。

<a id="dev-note"></a>
## 開發備註

無。
