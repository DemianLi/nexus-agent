<!-- 由 scripts/gen-third-party-notices.ts 產生，不要手改。
     改了相依之後跑 `pnpm run gen-third-party-notices` 重新產生。 -->

# 第三方元件

nexus-agent 用到下列第三方軟體。每個專案各自適用自己的授權，這個檔不改變任何授權條件。

這裡列的是 workspace **直接**宣告的相依。檔案由 `scripts/gen-third-party-notices.ts` 產生，`apps/harness/src/third-party-notices.test.ts` 在測試裡斷言進版控的內容跟重新產生的一致。改了相依跑 `pnpm run gen-third-party-notices`；只想檢查就跑 `pnpm run verify-third-party-notices`。

完整的遞移閉包連同精確版本記在 [`pnpm-lock.yaml`](pnpm-lock.yaml)，可以用 `pnpm licenses list` 查看。

## vendor 的原始碼

### `vendor/`

Cordis 框架與它的 Loader、Include 以原始碼複製進 repo，不經 npm 安裝，改名放在 `@nexus` scope 底下。三個都是 MIT，每個目錄保留上游的 `LICENSE`。上游 commit 與本地修改記在 [`vendor/README.md`](vendor/README.md)。

| 套件 | 上游套件名 | 來源 | 授權 |
| --- | --- | --- | --- |
| `@nexus/cordis` | `cordis` | [vendor/cordis](vendor/cordis/) | MIT |
| `@nexus/cordis-plugin-loader` | `@cordisjs/plugin-loader` | [vendor/loader](vendor/loader/) | MIT |
| `@nexus/cordis-plugin-include` | `@cordisjs/plugin-include` | [vendor/include](vendor/include/) | MIT |

### 網頁的 solid-glass

網頁的外觀與元件原樣複製自下列上游，打包進網頁的 `dist`。版本與本地修改記在 [`apps/web/src/vendor/solid-glass/README.md`](apps/web/src/vendor/solid-glass/README.md)。

| 上游 | 固定在 | 授權 |
| --- | --- | --- |
| [solid-glass](https://github.com/deeplethe/solid-glass) | `6e8903e494a1` | MIT |
| [shadcn](https://www.npmjs.com/package/shadcn) | 4.21.4 | MIT |

## 執行期的 npm 相依

安裝來在執行期使用，或打包進網頁 `dist` 的外部套件。網頁打包了哪些，是用 `apps/web` 自己的 vite 設定真的 build 一次收集的，不看它宣告在哪一段。這一層涵蓋每一顆可以從 `cordis.yml` 掛上的插件，不只預設載入的那些。

| 套件 | 授權 |
| --- | --- |
| [`@base-ui/react`](https://github.com/mui/base-ui) | MIT |
| [`@deepseek-ai/node-addon-system`](https://github.com/deepseek-harness/deepseek-harness) | BSD-3-Clause |
| [`@fontsource-variable/geist`](https://github.com/fontsource/font-files) | OFL-1.1 |
| [`@fontsource-variable/geist-mono`](https://github.com/fontsource/font-files) | OFL-1.1 |
| [`@fontsource-variable/noto-sans-tc`](https://github.com/fontsource/font-files) | OFL-1.1 |
| [`@langchain/core`](https://github.com/langchain-ai/langchainjs) | MIT |
| [`@langchain/langgraph`](https://github.com/langchain-ai/langgraphjs) | MIT |
| [`@langchain/langgraph-checkpoint`](https://github.com/langchain-ai/langgraphjs) | MIT |
| [`@langchain/langgraph-sdk`](https://github.com/langchain-ai/langgraphjs) | MIT |
| [`@langchain/mcp-adapters`](https://github.com/langchain-ai/langchainjs) | MIT |
| [`@langchain/openai`](https://github.com/langchain-ai/langchainjs) | MIT |
| [`@langchain/protocol`](https://www.npmjs.com/package/@langchain/protocol) | MIT |
| [`@opentelemetry/api-logs`](https://github.com/open-telemetry/opentelemetry-js) | Apache-2.0 |
| [`@opentelemetry/exporter-logs-otlp-http`](https://github.com/open-telemetry/opentelemetry-js) | Apache-2.0 |
| [`@opentelemetry/otlp-exporter-base`](https://github.com/open-telemetry/opentelemetry-js) | Apache-2.0 |
| [`@opentelemetry/resources`](https://github.com/open-telemetry/opentelemetry-js) | Apache-2.0 |
| [`@opentelemetry/sdk-logs`](https://github.com/open-telemetry/opentelemetry-js) | Apache-2.0 |
| [`@shadcn/react`](https://github.com/shadcn-ui/ui) | MIT |
| [`@shikijs/langs`](https://github.com/shikijs/shiki) | MIT |
| [`@standard-schema/spec`](https://github.com/standard-schema/standard-schema) | MIT |
| [`@vscode/ripgrep`](https://github.com/microsoft/vscode-ripgrep) | MIT |
| [`class-variance-authority`](https://github.com/joe-bell/cva) | Apache-2.0 |
| [`cmdk`](https://github.com/pacocoursey/cmdk) | MIT |
| [`cn`](https://github.com/shadcn-ui/cn) | MIT |
| [`cosmokit`](https://github.com/shigma/cosmokit) | MIT |
| [`deepagents`](https://github.com/langchain-ai/deepagentsjs) | MIT |
| [`diff`](https://github.com/kpdecker/jsdiff) | BSD-3-Clause |
| [`gpt-tokenizer`](https://github.com/niieani/gpt-tokenizer) | MIT |
| [`js-yaml`](https://github.com/nodeca/js-yaml) | MIT |
| [`katex`](https://github.com/KaTeX/KaTeX) | MIT |
| [`langchain`](https://github.com/langchain-ai/langchainjs) | MIT |
| [`langsmith`](https://github.com/langchain-ai/langsmith-sdk) | MIT |
| [`lucide-react`](https://github.com/lucide-icons/lucide) | ISC |
| [`mdast-util-from-markdown`](https://github.com/syntax-tree/mdast-util-from-markdown) | MIT |
| [`mdast-util-gfm`](https://github.com/syntax-tree/mdast-util-gfm) | MIT |
| [`mdast-util-math`](https://github.com/syntax-tree/mdast-util-math) | MIT |
| [`micromark-core-commonmark`](https://github.com/micromark/micromark/tree/main/packages/micromark-core-commonmark) | MIT |
| [`micromark-extension-gfm`](https://github.com/micromark/micromark-extension-gfm) | MIT |
| [`micromark-extension-math`](https://github.com/micromark/micromark-extension-math) | MIT |
| [`micromark-factory-space`](https://github.com/micromark/micromark/tree/main/packages/micromark-factory-space) | MIT |
| [`micromark-util-character`](https://github.com/micromark/micromark/tree/main/packages/micromark-util-character) | MIT |
| [`micromark-util-classify-character`](https://github.com/micromark/micromark/tree/main/packages/micromark-util-classify-character) | MIT |
| [`micromark-util-sanitize-uri`](https://github.com/micromark/micromark/tree/main/packages/micromark-util-sanitize-uri) | MIT |
| [`micromark-util-symbol`](https://github.com/micromark/micromark/tree/main/packages/micromark-util-symbol) | MIT |
| [`quickjs-emscripten`](https://github.com/justjake/quickjs-emscripten) | MIT |
| [`react`](https://github.com/react/react) | MIT |
| [`react-dom`](https://github.com/react/react) | MIT |
| [`semver`](https://github.com/npm/node-semver) | ISC |
| [`shiki`](https://github.com/shikijs/shiki) | MIT |
| [`sonner`](https://github.com/emilkowalski/sonner) | MIT |
| [`tailwindcss`](https://github.com/tailwindlabs/tailwindcss) | MIT |
| [`tw-animate-css`](https://github.com/Wombosvideo/tw-animate-css) | MIT |
| [`undici`](https://github.com/nodejs/undici) | MIT |
| [`yaml`](https://github.com/eemeli/yaml) | ISC |
| [`zod`](https://github.com/colinhacks/zod) | MIT |

## 網頁的字型

`@fontsource-variable/geist`、`@fontsource-variable/geist-mono`、`@fontsource-variable/noto-sans-tc` 宣告 SIL Open Font License 1.1（`OFL-1.1`），不在寬鬆授權的清單上；檢查只對這幾個套件名、而且授權剛好是 `OFL-1.1` 時放行。字型檔（`.woff2`）打包進網頁的 `dist`。

OFL 允許字型跟著軟體一起散布、也允許內嵌，條件是：不能單獨販售字型本身；散布時要附上原本的著作權聲明與 OFL 全文；修改過的字型不能沿用保留的字型名稱。

## 只在開發時用的 npm 相依

只為開發、測試、型別或工具**直接**宣告的外部套件，不在執行期安裝，也沒有打包進網頁。這裡的套件仍可能被某個執行期相依遞移帶進來，那以 `pnpm-lock.yaml` 為準。

| 套件 | 授權 |
| --- | --- |
| [`@eslint/js`](https://github.com/eslint/eslint) | MIT |
| [`@modelcontextprotocol/node`](https://github.com/modelcontextprotocol/typescript-sdk) | Apache-2.0 |
| [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) | MIT |
| [`@modelcontextprotocol/server`](https://github.com/modelcontextprotocol/typescript-sdk) | Apache-2.0 |
| [`@tailwindcss/vite`](https://github.com/tailwindlabs/tailwindcss) | MIT |
| [`@testing-library/react`](https://github.com/testing-library/react-testing-library) | MIT |
| [`@types/js-yaml`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT |
| [`@types/mdast`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT |
| [`@types/node`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT |
| [`@types/react`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT |
| [`@types/react-dom`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT |
| [`@types/semver`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT |
| [`@types/spdx-expression-parse`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT |
| [`@vitejs/plugin-react`](https://github.com/vitejs/vite-plugin-react) | MIT |
| [`ajv`](https://github.com/ajv-validator/ajv) | MIT |
| [`axe-core`](https://github.com/dequelabs/axe-core) | MPL-2.0 |
| [`colorjs.io`](https://github.com/color-js/color.js) | MIT |
| [`eslint`](https://github.com/eslint/eslint) | MIT |
| [`eslint-config-prettier`](https://github.com/prettier/eslint-config-prettier) | MIT |
| [`js-tiktoken`](https://github.com/dqbd/tiktoken) | MIT |
| [`jsdom`](https://github.com/jsdom/jsdom) | MIT |
| [`micromark-util-types`](https://github.com/micromark/micromark/tree/main/packages/micromark-util-types) | MIT |
| [`playwright-core`](https://github.com/microsoft/playwright) | Apache-2.0 |
| [`prettier`](https://github.com/prettier/prettier) | MIT |
| [`spdx-expression-parse`](https://github.com/jslicense/spdx-expression-parse.js) | MIT |
| [`tsdown`](https://github.com/rolldown/tsdown) | MIT |
| [`tsx`](https://github.com/privatenumber/tsx) | MIT |
| [`typescript`](https://github.com/microsoft/TypeScript) | Apache-2.0 |
| [`typescript-eslint`](https://github.com/typescript-eslint/typescript-eslint) | MIT |
| [`vite`](https://github.com/vitejs/vite) | MIT |
| [`vite-tsconfig-paths`](https://github.com/aleclarson/vite-tsconfig-paths) | MIT |
| [`vitest`](https://github.com/vitest-dev/vitest) | MIT |

`axe-core`（MPL-2.0） 只在開發時當工具跑，程式碼不會連結進、也不會隨 nexus 的任何產物發出去。
