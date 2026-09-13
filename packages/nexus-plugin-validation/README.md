# @nexus/plugin-validation

**兩半都搬進 `@nexus/core` 了，這裡只剩相容的名字與一個能力名。**

| 以前在這裡 | 現在在 | 搬家的卡 |
| --- | --- | --- |
| 圍堵：工具拋錯不殺掉整場 run | `packages/nexus-core/src/containment.ts`，fold 打底 | [#159](https://github.com/DemianLi/nexus-agent/issues/159) |
| 輸出 schema 校驗 | `packages/nexus-core/src/output-schema.ts`，fold 打底 | [#252](https://github.com/DemianLi/nexus-agent/issues/252) |

兩次是同一條論證：dsh 那側兩件事都是**註冊表執行管線自己做的**（`catch` 與
`createSuccessResult`），是性質不是功能。做成一個掛不掛隨人的 plugin 才是偏離——而這個
plugin 從來不在任何一份正式清單裡，兩件事住在這裡的期間，產品路徑上都等於沒有。

## 輸出 schema 現在怎麼宣告

跟著工具走，同 dsh `defineTool` 的 `output`：

```ts
registry.tools.register(fetchReport, {
  outputSchema: z.object({ total: z.number(), rows: z.array(z.string()) }),
});
```

沒宣告的工具明文放行。只有回 JSON 字串的工具宣告得了——驗的是 `JSON.parse(content)`。
兩條對 dsh 的偏離（強制不了、拿不到 canonical value）寫在 `output-schema.ts` 檔頭。

## 這個 plugin 還做什麼

`createValidationPlugin()` 只認領 `validation` 這個能力名，**一個 middleware 都不掛**。
`createContainmentMiddleware`、`createOutputSchemaMiddleware` 等名字仍從這裡 re-export 得出來
（相容），新的呼叫端請直接從 `@nexus/core` 拿。

## 不變量與業務規則：認帳不做

#252 第 2 項的結論。dsh 那側也沒有它們的家：訂 `tools/post-execute` 的全是政策與呈現
（spill、重複提醒、搜尋結果封頂），外加轉接使用者外部 `hooks.json` 的橋接，而橋接不在出廠
組合裡。業務規則住在工具本體；會寫到外部的那一顆（`submit_record`）一定經過核准卡，人看得到
填好的欄位。
