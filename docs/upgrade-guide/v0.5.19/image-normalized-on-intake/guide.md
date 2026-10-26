---
kind: upgrade-guide
description: 收下的圖在落盤前先規範化（轉正、縮圖、轉檔），attachments/ 不再留原圖，附件 id、媒體類型與寬高都改成規範化之後那一份的。
---

# 圖在收下時規範化，原圖不留

## 變更

v0.5.19 收下 `run.start` 內嵌的圖（base64）時只看檔頭，位元組原封不動存進 `attachments/`，附件 id 是原圖的 sha256，
送模型的也是原圖。新版（#2033）改了三件事：

1. **整張解碼，壞圖拒收。** 檔頭對、後面壞掉的圖（例如傳到一半截斷的 PNG）以前會收下，到組請求時才出事；
   新版在收下時就回 `invalid_argument`，一句話裡有一張不行整句不收、什麼都不寫。宣告的型別和位元組對不上的，
   同樣回 `invalid_argument`。
2. **落盤之前規範化，原圖不留。** 轉正（套 EXIF 轉向）、轉 8-bit sRGB、拿掉中繼資料（EXIF、ICC、XMP 等），
   總像素超過 2048×2048 的等比例縮到以內（例如 3000×2000 變 2508×1672），再編成 4 MiB 以內：
   有透明度的是 WebP，其餘是 JPEG。**GIF 一律重編（動圖只留第一幀），帶中繼資料的 JPEG、PNG 也會重編**；
   已經合格的（單幀、8-bit sRGB、沒有中繼資料、在上限內、不是 GIF）原樣存。存進 `attachments/`、網頁顯示、
   送模型的都是規範化之後那一份：
   - 附件 id 是規範化之後那份的 sha256，跟上傳的原圖算出來的不同；同一張圖，舊版存下的和新版存下的 id 也不同；
   - 參照的 `mediaType` 是規範化之後的（PNG、GIF 可能變成 `image/jpeg` 或 `image/webp`），`width`／`height` 也是；
   - 縮過的圖在參照上另記 `originalDimensions`（原圖轉正之後的寬高）。原圖的位元組、格式、大小不再留在任何地方。
3. **轉碼併發有上限。** 一個 serve 同時最多轉 2 張，超過的排隊；新開的 `attachment-images` 列可以調
   （`imageCompressionConcurrency`，1 到 8 的整數）。

升級前就存下的圖不動：照原樣讀、照原樣送模型，舊 thread 照常續接。

受影響的：

- **靠 `attachments/` 留使用者原檔做稽核或留存的部署**：升級之後，新收下的圖在 nexus 裡只有規範化之後那一份，
  原圖找不回來。
- **web 以外的客戶端**：自己算原圖的 sha256 去對附件 id、或認定送出的媒體類型會原樣回來的，會對不上。
- 送大圖、帶 EXIF 轉向的照片、GIF 動圖的使用者：模型看到的是縮過、轉正、只有一幀的版本。

## 遷移

1. 確認部署需不需要原圖。只要「`attachments/` 裡的就是使用者傳的那份」是你的稽核或留存依據，就屬於要處理的部署；
   不需要的跳到第 3 步。
2. 要留原圖的部署，在送進 nexus **之前**自己存：在送 `run.start` 的那一層（客戶端或前面的閘道）把 base64 解出來的
   原始位元組另外存一份，連同 thread id 與送出時間一起記。nexus 沒有「保留原圖」的設定可以開。
   web 以外的客戶端若要對附件 id，改用 `run.start` 回來之後日誌裡那筆參照的 `sha256`，不要用自己算的原圖雜湊。
3. 視主機的 CPU 與記憶體調轉碼併發（可略過，出廠 2）。每多一個名額，最壞多吃約 600 MiB 記憶體（8192×8192、16-bit 帶透明度的
   PNG 實測約 570 MiB；一般 8-bit 照片約 280 MiB），調到 8 最壞約 4.5 GiB。寫在 `--patch` 檔：

   ```yaml
   - id: attachment-images
     config:
       imageCompressionConcurrency: 4
   ```

   用變更紀錄管設定的，用 `plugin config set attachment-images --file -` 整份換掉。這一列只有 `serve` 載，
   改了要重啟 serve 才生效。範圍外的值驗不過：serve 照樣起來，但那一列掉了、退回出廠的 2，啟動輸出多一行
   `attachment-images（#settings/attachment-images）設定驗不過：…`。
4. 確認：啟動輸出有一行 `圖片轉碼併發：N 張（超過的排隊）`，N 是你要的值，而且沒有提到 `attachment-images` 的「設定驗不過」。開一條新 thread，附一張長寬都超過 2048 的 PNG 送出。在會話日誌（home 底下的 `sessions/`）
   找到那一筆的附件參照：`mediaType` 是 `image/jpeg`（有透明度的是 `image/webp`），`width × height` 不超過
   2048×2048，`originalDimensions` 是原圖的寬高；`attachments/v1/file-objects/<id 的前兩碼>/<id>` 那個檔的 sha256
   等於參照的 id，而且跟你上傳的原圖的 sha256 不同。
