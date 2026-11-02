---
kind: upgrade-guide
description: write_file 一律把內容當 UTF-8 文字寫；以前對 .png、.pdf 這類副檔名會把內容當 base64 解成位元組，靠它寫位元組的插件要改走 uploadFiles。
---

# write_file 一律寫文字

## 變更

v0.5.19 的 `write_file`（以及外部插件經 `@nexus/fs` 的 `fs.backend()` 拿到的 backend `.write(path, content)`）看**副檔名**決定怎麼寫：
副檔名是圖（`.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.heic`、`.heif`）、音（`.mp3`、`.wav`、`.aiff`、`.aac`、`.ogg`、`.flac`）、
影（`.mp4`、`.webm`、`.mpeg`、`.mov`、`.avi`、`.flv`、`.mpg`、`.wmv`、`.3gpp`）、`.pdf`、`.ppt`、`.pptx`（大小寫不分）時，
把 `content` 當 **base64** 解碼成位元組再寫；其他副檔名寫文字。工具描述沒有講這件事，模型寫進 `.png` 的純文字會落成亂碼，工具還回成功。

新版（[#1813](https://github.com/DemianLi/nexus-agent/issues/1813)，照 dsh：它的 `write` 沒有任何依副檔名的分支）**所有副檔名都把 `content` 當 UTF-8 文字寫**，
落盤就是給的那段字。沒給 `--workspace`、內容存在 graph state 的那一格行為相同（存成文字，不再解碼）。

受影響的：傳 base64 字串給上面那些副檔名、期待寫出位元組的外部插件與腳本。升級之後同一個呼叫成功，但檔案內容是那串 base64 文字，
不是原本的位元組，**不會報錯**。模型這邊不受影響（它寫的本來就是文字，現在才寫對）；內建的暫存、外溢、摘要歷史寫的是 `.txt`／`.md`，也不受影響。

## 遷移

1. 找出你的插件與腳本裡對 backend 的 `.write(`（或 `write_file`）呼叫，挑出路徑副檔名在上面那串、而且內容是 base64 的。沒有就不用做別的。
2. 要寫位元組的，改走 `backend.uploadFiles([[path, bytes]])`，`bytes` 是 `Uint8Array`（不是 base64 字串）；它不看副檔名、原樣寫位元組，
   也過同一道路徑圍欄。
3. 確認改好了：寫一個已知內容的檔（例如一張 1×1 的 PNG），用 `backend.downloadFiles([path])` 讀回，位元組逐個等於你交進去的那份
   （舊寫法在新版會讀回 base64 的文字，長度比原圖大三分之一左右）。
