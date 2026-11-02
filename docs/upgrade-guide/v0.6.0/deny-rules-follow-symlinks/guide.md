---
kind: upgrade-guide
description: 插件用 registry.permissions.deny() 註冊的規則，經工作區裡的符號連結也擋得住，以前經連結讀寫得到的會被拒。
---

# deny 規則經符號連結也擋

## 變更

v0.6.0 裡，插件在 `apply` 裡用 `registry.permissions.deny()` 註冊的規則只比模型給的路徑。工作區（或共用區 `/shared`）
裡有一條連結指到被擋的路徑時，經連結就讀寫得到：

- 檔案連結：`read_file`、`write_file`、`edit_file`、`delete` 對連結的路徑都照常做，動到的是被擋的那個檔；
- 目錄連結：連結底下的檔讀得到、列得出、搜得到，也能在底下新建檔。

新版（#2260）解開連結之後，位置跟模型給的路徑不同時，拿同一份規則再比一次，命中就拒。模型看到的拒絕句跟直接
用被擋路徑時同一種：`Error: permission denied for read on /secret/key.txt`，路徑是解開之後的那一個。

- 不分沙箱模式，`danger-full-access` 也擋；
- 例外（`except`）照舊有效，經連結指到例外裡的檔照常讀寫；
- 沒經連結的路徑不變，包括 harness 自己經 backend 讀的技能掃描與記憶來源；這些讀取經連結指到被擋的路徑時，同樣被拒；
- 子代理自己在 `permissions` 裡加的規則不經連結重比，只比全域註冊的那一份。

**受影響的是：** 裝了會呼叫 `registry.permissions.deny()` 的插件，而且工作區或共用區裡有連結指到被擋路徑的部署。
出貨的設定沒有這樣的插件，沒裝的不受影響。

## 遷移

1. 確認有沒有插件註冊 deny 規則：在部署的插件原始碼裡找 `permissions.deny(`。找不到就不受影響，後面幾步不必做。
2. 找出工作區（`--workspace` 指的目錄）裡的連結，以及它們指到哪裡；有共用區的，對共用區的目錄也跑一次：
   `find . -type l -exec sh -c 'printf "%s -> %s\n" "$1" "$(readlink -f "$1")"' _ {} \;`。
   對照第 1 步的規則，列出指到被擋路徑的那幾條。規則比的是虛擬路徑：工作區根是 `/`，共用區是 `/shared`，
   不是 `readlink -f` 印出的主機路徑。
3. 每一條決定怎麼處理：
   - **本來就不該讓模型經連結碰到**：不必處理，升級之後經連結會被拒。
   - **要讓模型讀寫連結指到的內容**：在那條 deny 的 `except` 裡加上被指到的虛擬路徑，或把連結換成一份複本：
     檔案連結用 `cp "$(readlink -f <連結>)" <連結>.copy && mv <連結>.copy <連結>`，
     目錄連結用 `cp -R "$(readlink -f <連結>)" <連結>.copy && rm <連結> && mv <連結>.copy <連結>`。
4. 確認：開一條新 thread，請模型讀其中一條指到被擋路徑的連結。會話日誌（home 底下的 `sessions/`）裡那一筆
   `read_file` 的 `tool/result` 是錯誤，內容是 `Error: permission denied for read on <解開之後的路徑>`；
   第 3 步加進 `except` 或換成複本的，照常讀得到。
