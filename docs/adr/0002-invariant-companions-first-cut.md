# 運行時不變量配套入口：拿掉空殼，剩下的八個暫時保留

2026-10-03 的決定（類別：項目）。各套件自己發布的「運行時不變量」配套入口（`src/invariant.ts`）原本二十個全進；其中十二個是空 installer，一個檢查都不裝，只買到包名歸屬。這十二個拿掉，`harness/apps/harness/src/package-invariants.ts` 的閘門翻面：空 installer 本身算違規，沒有配套入口的套件不再算違規。

剩下的八個是真的在檢查跨筆關係，**暫時保留、觀察中**。dsh 已於 `f028f25667d`（2026-09-30）把整套運行時不變量移除，所以這不是「現有基礎建設表達不出來」的偏離，是刻意暫留；第二刀（要不要拿掉這八個）沒有決定。

## Considered Options

- **全部拿掉**：最貼近 dsh，但八個真檢查沒了，接線防線要另找載體，規模約 5,200 行。
- **全部保留並登記為偏離**：幾乎沒有改動，但 `AGENTS.md` 的偏離條款是為「表達不出來」寫的，這裡是「dsh 已不做」。
- **兩刀，先拿掉十二個空殼（採用）**：第一刀不損失任何偵測能力，且與 dsh 在整套移除之前就定下的「沒有獨立觀察就不要發布配套入口」一致。

## Consequences

- 檔頭與設定要照實寫「暫時保留、觀察中」，見 `harness/packages/nexus-core/src/invariants.ts` 與 `harness/apps/harness/cordis.yml` 的配套入口段。
- 第二刀的重審條件（提議，尚未拍板）、可能走向、八個檢查的清單與當時量到的事實，在 tag [`archive/docs-2026-11`](https://github.com/DemianLi/nexus-agent/blob/archive/docs-2026-11/.docs/invariant-companions-decision-2026-10-03.md) 的原文。
