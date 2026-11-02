---
kind: upgrade-guide
description: SKILL.md 的 disable-model-invocation／user-invocable 開始生效；寫了舊鍵或不在值表上的值，整份技能不再列給模型。
---

# 技能的調用旗標開始生效，寫錯的整份不收

## 變更

v0.5.19 的技能清單不讀 SKILL.md frontmatter 的 `disable-model-invocation` 與 `user-invocable`：掃到的技能全部列進模型的提示詞，
旗標寫什麼、寫錯什麼都一樣。新版（#1574）照 dsh 解析這兩個旗標，root 與凡是規格帶 `skills` 的子代理（出廠是 general-purpose）都適用：

1. **`disable-model-invocation: true` 的技能不再列給模型。** 同名的技能看優先序（`sources` 後面的贏）：勝出那一份標了這個旗標，
   所有來源裡同名的那幾份都不列；勝出那一份沒標，就列勝出那一份。只擋清單，不擋讀檔：提示詞照舊印出技能來源目錄，
   模型自己 `ls`、`read_file` 照樣讀得到那份檔。
2. **旗標寫錯的技能整份不收（fail-closed）。** 兩種寫錯：
   - 舊鍵：`disableModelInvocation`、`modelInvocable`、`userInvocable`；
   - 值不在值表上。值表是：`true`、`false`、`1`、`0`，以及字串 `true`／`yes`／`on`、`false`／`no`／`off`（不分大小寫）。`maybe`、`null`、`2`、空字串都不行。

   這種技能不列給模型，也不參與同名決勝：順位較低的同名技能照常列。每掃描一次，用 `console.warn` 記一行
   `技能檔 <路徑> 不收：調用旗標不合規則：…`（沒有另外接管，寫到 serve 行程的標準錯誤輸出），路徑是 backend 裡的路徑
   （例如 `/skills/deploy/SKILL.md`）。
3. **掃描讀 `SKILL.md` 遇到「不存在」以外的錯誤（例如權限不足），那一次一份技能都不列給模型。** v0.5.19 是安靜地跳過讀不到的那一份、
   其餘照列；讀不到的那份叫什麼名字不知道，照舊列其餘的，可能讓順位較低的同名技能頂上來。（出廠的檔案 backend 列目錄失敗時回空列表，
   跟目錄是空的分不開，那一種照舊當成空的。）新版記一行 `技能清單這一次不給模型：掃描不完整：…`，下一次 invoke 重掃，錯誤排除了就照常列。

`user-invocable: false` 只管人打 `/名字` 叫不叫得出來（出貨清單的 `skill-invocation` 那一列，見 `default-plugin-additions` 那份指南），
對模型看到的清單沒有影響。旗標寫錯的技能人也叫不出來；掃描不完整的那一次，人叫的也一份都不注入，記一行
`技能叫用這一次不注入：掃描不完整（/名字）`。

受影響的：技能來源裡有 SKILL.md 寫了這兩個旗標、或寫了上面三個舊鍵的主機；以及技能目錄裡有權限讀不到的檔的主機。
沒寫旗標的技能，模型看到的提示詞逐位元組不變。

## 遷移

1. 找出寫了旗標或舊鍵的 SKILL.md。在每個技能來源目錄（出廠是 `--workspace` 底下的 `skills/`，serve 的新對話也讀這一個）跑：
   `grep -rnE '^(disable-model-invocation|user-invocable|disableModelInvocation|modelInvocable|userInvocable):' skills/`。
   沒有輸出就跳到第 5 步。
2. 舊鍵改掉：
   - `disableModelInvocation: true` 改成 `disable-model-invocation: true`；`disableModelInvocation: false` 直接刪掉；
   - `modelInvocable: false` 改成 `disable-model-invocation: true`；`modelInvocable: true` 直接刪掉（不是換成新鍵）；
   - `userInvocable` 改成 `user-invocable`，值照舊。
3. 值不在值表上的，改成 `true` 或 `false`。
4. 標了 `disable-model-invocation: true` 的技能，確認它本來就不該讓模型自己挑；要讓模型照舊看到，拿掉這一行。
5. 確認技能目錄每個 `SKILL.md` 都讀得到：`find skills/ -name SKILL.md ! -readable`（以跑 serve 的帳號執行）沒有輸出。
6. 確認：重啟 serve、開一條新 thread 打一輪，標準錯誤輸出沒有 `不收：調用旗標不合規則`，也沒有 `掃描不完整` 的行。
