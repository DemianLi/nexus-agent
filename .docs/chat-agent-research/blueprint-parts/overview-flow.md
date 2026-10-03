### 資料流

八個節點與六條邊（依 `data/topics.json`），圖照 demian 提供的框架圖畫：實線是主幹與分支，虛線是回饋邊。T3 與 T8 不是六條邊的端點。

```mermaid
flowchart TD
  T1["T1 Goal Alignment & Intent Detection"] --> T2["T2 Multi-Turn State Tracking (DST)"]
  T2 --> T3["T3 Agent Observation"]
  T3 --> T4["T4 Agent Trace / Trajectory"]
  T4 --> T7["T7 Agent Evaluation / Eval"]
  T7 --> T8["T8 Task Completion Score"]
  T4 -- "E3 Anomalies Detected" --> T5["T5 Self-Correction & Reflection"]
  T4 -- "E4 Nominal Path" --> T6["T6 User Simulator & User Feedback Loop"]
  T6 -. "E1 External Input" .-> T1
  T5 -. "E2 State Adjustments" .-> T2
  T5 -. "E5 Correction Logs" .-> T7
  T6 -. "E6 Interaction Logs" .-> T7
```

E1（T6→T1）使用者輸入進入目標對齊；E2（T5→T2）修正結果寫回狀態；E3（T4→T5）偵測到異常觸發修正；E4（T4→T6）正常路徑繼續互動；E5（T5→T7）修正紀錄回流評估；E6（T6→T7）互動紀錄回流評估。這張圖只是地圖，不代表有論文驗過整條線（見第 6 節）。

**主幹的五條箭頭沒有介面契約。** 圖上實線的主幹（T1→T2、T2→T3、T3→T4、T4→T7、T7→T8）不在調研一開始定義的六條邊裡，讀過的論文也沒有把它們當邊研究過，所以第 5 節的介面契約只涵蓋六條有名字的邊。各箭頭目前被哪些卡碰到：

| 箭頭 | 碰到它的卡 | 狀態 |
| --- | --- | --- |
| T1→T2 | T1-10（C，推論：把推斷出的目標寫成顯式交接物） | T2 沒有任何一張卡以「從 T1 接什麼」為題 |
| T2→T3 | 沒有 | — |
| T3→T4 | 沒有直接以此為題的卡；最接近的是 T4-08（待決：軌跡用什麼格式記錄） | 待決 |
| T4→T7 | T7-10（C，推論：評估端要持續讀取的紀錄最少要包含什麼）、T4-08（待決） | 沒有 A 或 B 級的卡 |
| T7→T8 | T8 整節談分數怎麼定義、聚合與報告，T7-06 談跑幾次與區間 | 沒有一張卡把「T7 交給 T8 的是什麼」當介面來寫 |

**這張圖與整份方案涵蓋的是自我進化之前的底座**：觀測、軌跡、當場修正（T5 只改這一場對話的狀態）、使用者模擬、評估與計分。T7、T8 的輸出只通到分數，沒有任何箭頭回到 agent 去改提示詞、記憶、工具或權重，所以「量到→提出改動→驗證改動→收進去」這個閉環不在範圍內；讀過的論文也沒有人驗過這種端到端閉環（README〈整個框架的未解問題〉第 2 題）。第 3 節的量測規則可以當作那個閉環的準入條件，但這一句是推論，沒有論文驗過。
