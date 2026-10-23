---
kind: upgrade-guide
description: SKILL.md 的 disable-model-invocation／user-invocable 開始生效；寫了舊鍵或不在值表上的值，整份技能不再列給模型。
---

# 技能的調用旗標開始生效，寫錯的整份不收

## 變更

v0.5.19 的技能清單不讀 SKILL.md frontmatter 的 `disable-model-invocation` 與 `user-invocable`：掃到的技能全部列進模型的提示詞，
旗標寫什麼、寫錯什麼都一樣。新版（#1574）照 dsh 解析這兩個旗標，root 與 general-purpose 子代理都適用：

1. **`disable-model-invocation: true` 的技能不再列給模型。** 同名的技能看優先序（`sources` 後面的贏）：勝出那一份標了這個旗標，
   所有來源裡同名的那幾份都不列；勝出那一份沒標，就列勝出那一份。只擋清單：路徑沒列出來，但模型自己用 `read_file` 去讀，照樣讀得到。
2. **旗標寫錯的技能整份不收（fail-closed）。** 兩種寫錯：
   - 舊鍵：`disableModelInvocation`、`modelInvocable`、`userInvocable`；
   - 值不在值表上。值表是：`true`、`false`、`1`、`0`，以及字串 `true`／`yes`／`on`、`false`／`no`／`off`（不分大小寫）。`maybe`、`null`、`2`、空字串都不行。

   這種技能不列給模型，也不參與同名決勝：順位較低的同名技能照常列。每掃描一次，serve 的標準錯誤輸出記一行
   `技能檔 <路徑> 不收：調用旗標不合規則：…`，路徑是 backend 裡的路徑（例如 `/skills/deploy/SKILL.md`）。

`user-invocable: false` 只管人打 `/名字` 叫不叫得出來，這一版還沒有那個入口，對模型看到的清單沒有影響。

受影響的：技能來源裡有 SKILL.md 寫了這兩個旗標、或寫了上面三個舊鍵的主機。沒寫旗標的技能，模型看到的提示詞逐位元組不變。

## 遷移

1. 找出寫了旗標或舊鍵的 SKILL.md。在每個技能來源目錄（出廠是工作區的 `skills/`）跑：
   `grep -rnE '^(disable-model-invocation|user-invocable|disableModelInvocation|modelInvocable|userInvocable):' skills/`。
   沒有輸出就不受影響，後面幾步不必做。
2. 舊鍵改成新鍵：`disableModelInvocation: true` 改成 `disable-model-invocation: true`；`modelInvocable: false` 改成
   `disable-model-invocation: true`；`userInvocable` 改成 `user-invocable`，值照舊。
3. 值不在值表上的，改成 `true` 或 `false`。
4. 標了 `disable-model-invocation: true` 的技能，確認它本來就不該讓模型自己挑；要讓模型照舊看到，拿掉這一行。
5. 確認：重啟 serve、開一條新 thread 打一輪，標準錯誤輸出沒有 `不收：調用旗標不合規則` 的行。
