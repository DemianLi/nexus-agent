# SBOM 相依的維護者與來源（#2254）

基準：develop `7c8f4abacfe3`，查詢日 2026-11-01，平台 linux-x64。資料只取公開中繼資料，沒有下載套件本體。維護者與 repo 是各 registry 上的自述，**沒有驗證身分**。

## 涵蓋範圍

| 來源 | 列數 | 取法 |
| --- | --- | --- |
| npm 閉包 | 112 | 從 `pnpm-lock.yaml` 的 `apps/harness` 走正式相依，含符合平台的 optional（其中 4 顆同時打包進 web） |
| web 打包 | 105 | `vite build --sourcemap` 產物的 `sources`，加 web CSS 的 `@import`／`@plugin`；都是 devDependency，不在 Release 的 SBOM 裡 |
| web vendor | 2 | `apps/web/src/vendor/solid-glass/manifest.json` |
| vendor | 4 | `vendor/README.md`，維護者取上游 npm 最新版 |
| crate | 11 | `Cargo.lock`，備註欄分「連進執行檔」與「只在建置時」；SBOM 只列前者 |
| 工具鏈 | 3 | `scripts/release/spawner.ts`、`rust-toolchain.toml` |
| 第一方 | 43 顆 | 本 repo，repo 與維護者都是 DemianLi/nexus-agent，不另列（清單見下） |

SBOM 的 `nexus-sandbox-spawner` 執行檔也是第一方。

**閉包核對：** 目前沒有這個 commit 的 linux-x64 SBOM（最新 Release 是 v0.5.19）。同一支走訪換成 darwin-arm64，對 #1937 複查時實際打包的 `.cdx.json`，158 顆完全一致，多出的 1 顆是根套件。linux-x64 本身沒有對過實際產物。

## 結果

- **solid-glass 的來源：** `deeplethe/solid-glass` 屬於 GitHub 組織 DeepLethe，組織建立於 2026-05-08，repo 建立於 2026-10-12，MIT。我們釘的 `6e8903e4` 在上游存在，作者 WaylandYang，2026-10-16。組織成員不公開；WaylandYang 的個人頁自述 DeepLethe、新加坡／中國、`deeplethe.com`。**法律實體查不到。**
- **`@deepseek-ai/node-addon-system`：** 兩顆的 `repository` 都寫 `deepseek-harness/deepseek-harness`，GitHub 回 404；組織 `deepseek-harness` 存在（2026-05-26 建立）。公開的 `deepseek-ai/deepseek-harness` 是否就是它的原始碼，沒有查證。維護者 imccyu、tianyicui-deepseek。
- **Cordis：** 四顆 vendor 的上游是 `cordiverse/cordis`，npm 維護者只有 shigma；閉包裡的 `cosmokit` 同一人。
- **單一維護者：** 237 列裡 119 列只有一位維護者。
- **授權：** 全部查得到。非寬鬆的只有 `@img/sharp-libvips-linux-x64` 的 LGPL-3.0-or-later，與 #1545 已審過的相同；OFL-1.1 是字型。這裡記的是 registry 欄位，不是逐檔授權審查。

## 查不到的

| 項目 | 欄位 |
| --- | --- |
| `@langchain/protocol` 0.0.18、0.0.19 | repo：manifest 沒寫 |
| `@deepseek-ai/node-addon-system`、`-linux-x64` | repo 擁有者：宣告的 repo 404 |
| `llvm-libunwind`、`musl`、`rust-std` | 維護者、發布者：不走 registry |
| `musl` | repo 擁有者：不在 GitHub |
| `libc` | 發布者：crates.io 沒回 |
| `solid-glass` | 發布者：不走 registry |

「GitHub Actions」是 npm 記的發布身分，代表由 CI 發布，不是某個人。

## 重跑

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm --filter @nexus/web exec vite build --sourcemap --outDir /var/tmp/sbom-webdist --emptyOutDir
```

```bash
pnpm exec tsx .docs/sbom-provenance/collect.ts --web-dist /var/tmp/sbom-webdist --out /var/tmp/sbom-provenance.json
```

第三步寫出 `/var/tmp/sbom-provenance.json` 與旁邊的 `.table.md`，後者取代下面的表。查 `registry.npmjs.org`、`crates.io`（每秒一次）與 `gh api`。

核對閉包：對一份實際打包的 `.cdx.json`，兩個差集應只剩根套件。

```bash
pnpm exec tsx .docs/sbom-provenance/collect.ts --platform darwin-arm64 --check-sbom <路徑>.cdx.json
```

## 第一方

@nexus/agent-loop、@nexus/approval-channel、@nexus/brand、@nexus/commands、@nexus/core、@nexus/deque、@nexus/feedback、@nexus/fs、@nexus/goal、@nexus/harness、@nexus/permission-presets、@nexus/plugin-agent-instructions、@nexus/plugin-ask-user、@nexus/plugin-commands、@nexus/plugin-echo、@nexus/plugin-feedback、@nexus/plugin-goal、@nexus/plugin-mcp、@nexus/plugin-memory、@nexus/plugin-permission-presets、@nexus/plugin-plan-mode、@nexus/plugin-present、@nexus/plugin-quickjs、@nexus/plugin-sandbox-policy、@nexus/plugin-skills、@nexus/plugin-submit-record、@nexus/plugin-system-prompt、@nexus/plugin-telemetry-otel、@nexus/plugin-time-context、@nexus/plugin-todo、@nexus/plugin-token-meter、@nexus/plugin-trajectory、@nexus/plugin-workspace-changes、@nexus/projections、@nexus/sdk、@nexus/session、@nexus/skills、@nexus/system-prompt、@nexus/timeout、@nexus/tool-result、@nexus/tools、@nexus/web、@nexus/wire

## 表

| 套件 | 版本 | 來源 | repo | repo 擁有者 | 維護者 | 最後發布者 | 授權 | 備註 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| @base-ui/react | 1.9.0 | web 打包 | https://github.com/mui/base-ui | mui（Organization） | oliviertassinari、atomiks、lukastyla、janpotoms、colmtuite、mnajdova、michaldudak、mj12albert | GitHub Actions | MIT |  |
| @base-ui/utils | 0.5.0 | web 打包 | https://github.com/mui/base-ui | mui（Organization） | oliviertassinari、atomiks、lukastyla、janpotoms、colmtuite、mnajdova、michaldudak、mj12albert | GitHub Actions | MIT |  |
| @cfworker/json-schema | 4.1.1 | npm 閉包 | https://github.com/cfworker/cfworker | cfworker（Organization） | jdanyow | jdanyow | MIT |  |
| @deepseek-ai/node-addon-system-linux-x64 | 0.1.2 | npm 閉包 | https://github.com/deepseek-harness/deepseek-harness | 查不到 | imccyu、tianyicui-deepseek | imccyu | BSD-3-Clause |  |
| @deepseek-ai/node-addon-system | 0.1.2 | npm 閉包 | https://github.com/deepseek-harness/deepseek-harness | 查不到 | imccyu、tianyicui-deepseek | imccyu | BSD-3-Clause |  |
| @eslint-community/regexpp | 4.12.2 | npm 閉包 | https://github.com/eslint-community/regexpp | eslint-community（Organization） | eslint-community-bot、michaeldeboey | GitHub Actions | MIT |  |
| @floating-ui/core | 1.8.0 | web 打包 | https://github.com/floating-ui/floating-ui | floating-ui（Organization） | fezvrasta、atomiks | GitHub Actions | MIT |  |
| @floating-ui/dom | 1.8.0 | web 打包 | https://github.com/floating-ui/floating-ui | floating-ui（Organization） | fezvrasta、atomiks | GitHub Actions | MIT |  |
| @floating-ui/react-dom | 2.1.9 | web 打包 | https://github.com/floating-ui/floating-ui | floating-ui（Organization） | fezvrasta、atomiks | GitHub Actions | MIT |  |
| @floating-ui/utils | 0.2.12 | web 打包 | https://github.com/floating-ui/floating-ui | floating-ui（Organization） | fezvrasta、atomiks | GitHub Actions | MIT |  |
| @fontsource-variable/noto-sans-tc | 5.3.0 | web 打包 | https://github.com/fontsource/font-files | fontsource（Organization） | jwr1、lotusdevshack | lotusdevshack | OFL-1.1 |  |
| @img/colour | 1.1.0 | npm 閉包 | https://github.com/lovell/colour | lovell（User） | lovell | GitHub Actions | MIT |  |
| @img/sharp-libvips-linux-x64 | 1.3.4 | npm 閉包 | https://github.com/lovell/sharp-libvips | lovell（User） | lovell | GitHub Actions | LGPL-3.0-or-later |  |
| @img/sharp-linux-x64 | 0.35.5 | npm 閉包 | https://github.com/lovell/sharp | lovell（User） | lovell | GitHub Actions | Apache-2.0 |  |
| @jitl/quickjs-ffi-types | 0.32.0 | npm 閉包 | https://github.com/justjake/quickjs-emscripten | justjake（User） | jitl | jitl | MIT |  |
| @jitl/quickjs-wasmfile-debug-asyncify | 0.32.0 | npm 閉包 | https://github.com/justjake/quickjs-emscripten | justjake（User） | jitl | jitl | MIT |  |
| @jitl/quickjs-wasmfile-debug-sync | 0.32.0 | npm 閉包 | https://github.com/justjake/quickjs-emscripten | justjake（User） | jitl | jitl | MIT |  |
| @jitl/quickjs-wasmfile-release-asyncify | 0.32.0 | npm 閉包 | https://github.com/justjake/quickjs-emscripten | justjake（User） | jitl | jitl | MIT |  |
| @jitl/quickjs-wasmfile-release-sync | 0.32.0 | npm 閉包 | https://github.com/justjake/quickjs-emscripten | justjake（User） | jitl | jitl | MIT |  |
| @langchain/core | 1.2.9 | npm 閉包 | https://github.com/langchain-ai/langchainjs | langchain-ai（Organization） | lc-oss-admin、langchain-security | GitHub Actions | MIT |  |
| @langchain/langgraph-checkpoint | 1.1.5 | npm 閉包 | https://github.com/langchain-ai/langgraphjs | langchain-ai（Organization） | lc-oss-admin、langchain-security | GitHub Actions | MIT |  |
| @langchain/langgraph-sdk | 1.12.1 | npm 閉包 | https://github.com/langchain-ai/langgraphjs | langchain-ai（Organization） | lc-oss-admin、langchain-security | GitHub Actions | MIT |  |
| @langchain/langgraph-sdk | 1.9.31 | npm 閉包 | https://github.com/langchain-ai/langgraphjs | langchain-ai（Organization） | lc-oss-admin、langchain-security | GitHub Actions | MIT |  |
| @langchain/langgraph | 1.4.19 | npm 閉包 | https://github.com/langchain-ai/langgraphjs | langchain-ai（Organization） | lc-oss-admin、langchain-security | GitHub Actions | MIT |  |
| @langchain/mcp-adapters | 2.0.0 | npm 閉包 | https://github.com/langchain-ai/langchainjs | langchain-ai（Organization） | lc-oss-admin、langchain-security | GitHub Actions | MIT |  |
| @langchain/openai | 1.5.10 | npm 閉包 | https://github.com/langchain-ai/langchainjs | langchain-ai（Organization） | lc-oss-admin、langchain-security | GitHub Actions | MIT |  |
| @langchain/protocol | 0.0.18 | npm 閉包 | 查不到 | 查不到 | lc-oss-admin、langchain-security | lc-oss-admin | MIT |  |
| @langchain/protocol | 0.0.19 | npm 閉包 | 查不到 | 查不到 | lc-oss-admin、langchain-security | lc-oss-admin | MIT |  |
| @modelcontextprotocol/client | 2.3.1 | npm 閉包 | https://github.com/modelcontextprotocol/typescript-sdk | modelcontextprotocol（Organization） | jspahrsummers、pcarleton、fweinberger、thedsp、ochafik-ant | GitHub Actions | Apache-2.0 |  |
| @modelcontextprotocol/core | 2.3.1 | npm 閉包 | https://github.com/modelcontextprotocol/typescript-sdk | modelcontextprotocol（Organization） | jspahrsummers、pcarleton、fweinberger、thedsp、ochafik-ant | GitHub Actions | Apache-2.0 |  |
| @nodelib/fs.scandir | 2.1.5 | npm 閉包 | https://github.com/nodelib/nodelib/tree/master/packages/fs/fs.scandir | nodelib（Organization） | mrmlnc | mrmlnc | MIT |  |
| @nodelib/fs.stat | 2.0.5 | npm 閉包 | https://github.com/nodelib/nodelib/tree/master/packages/fs/fs.stat | nodelib（Organization） | mrmlnc | mrmlnc | MIT |  |
| @nodelib/fs.walk | 1.2.8 | npm 閉包 | https://github.com/nodelib/nodelib/tree/master/packages/fs/fs.walk | nodelib（Organization） | mrmlnc | mrmlnc | MIT |  |
| @opentelemetry/api-logs | 0.221.0 | npm 閉包 | https://github.com/open-telemetry/opentelemetry-js | open-telemetry（Organization） | dyladan、pichlermarc、overbalance、npmjs-account、trentm、martinkuba | GitHub Actions | Apache-2.0 |  |
| @opentelemetry/api | 1.9.1 | npm 閉包 | https://github.com/open-telemetry/opentelemetry-js | open-telemetry（Organization） | dyladan、pichlermarc、npmjs-account、trentm | GitHub Actions | Apache-2.0 |  |
| @opentelemetry/core | 2.10.0 | npm 閉包 | https://github.com/open-telemetry/opentelemetry-js | open-telemetry（Organization） | dyladan、pichlermarc、overbalance、npmjs-account、trentm、martinkuba | GitHub Actions | Apache-2.0 |  |
| @opentelemetry/exporter-logs-otlp-http | 0.221.0 | npm 閉包 | https://github.com/open-telemetry/opentelemetry-js | open-telemetry（Organization） | dyladan、pichlermarc、overbalance、npmjs-account、trentm、martinkuba | GitHub Actions | Apache-2.0 |  |
| @opentelemetry/otlp-exporter-base | 0.221.0 | npm 閉包 | https://github.com/open-telemetry/opentelemetry-js | open-telemetry（Organization） | dyladan、pichlermarc、overbalance、npmjs-account、trentm、martinkuba | GitHub Actions | Apache-2.0 |  |
| @opentelemetry/otlp-transformer | 0.221.0 | npm 閉包 | https://github.com/open-telemetry/opentelemetry-js | open-telemetry（Organization） | dyladan、pichlermarc、overbalance、npmjs-account、trentm、martinkuba | GitHub Actions | Apache-2.0 |  |
| @opentelemetry/resources | 2.10.0 | npm 閉包 | https://github.com/open-telemetry/opentelemetry-js | open-telemetry（Organization） | dyladan、pichlermarc、overbalance、npmjs-account、trentm、martinkuba | GitHub Actions | Apache-2.0 |  |
| @opentelemetry/sdk-logs | 0.221.0 | npm 閉包 | https://github.com/open-telemetry/opentelemetry-js | open-telemetry（Organization） | dyladan、pichlermarc、overbalance、npmjs-account、trentm、martinkuba | GitHub Actions | Apache-2.0 |  |
| @opentelemetry/sdk-metrics | 2.10.0 | npm 閉包 | https://github.com/open-telemetry/opentelemetry-js | open-telemetry（Organization） | dyladan、pichlermarc、overbalance、npmjs-account、trentm、martinkuba | GitHub Actions | Apache-2.0 |  |
| @opentelemetry/sdk-trace | 2.10.0 | npm 閉包 | https://github.com/open-telemetry/opentelemetry-js | open-telemetry（Organization） | dyladan、pichlermarc、overbalance、npmjs-account、trentm、martinkuba | GitHub Actions | Apache-2.0 |  |
| @opentelemetry/semantic-conventions | 1.43.0 | npm 閉包 | https://github.com/open-telemetry/opentelemetry-js | open-telemetry（Organization） | dyladan、pichlermarc、overbalance、npmjs-account、trentm、martinkuba | GitHub Actions | Apache-2.0 |  |
| @radix-ui/primitive | 1.1.7 | web 打包 | https://github.com/radix-ui/primitives | radix-ui（Organization） | hadihallak、chancestrickland、mark-workos、npm-workos | GitHub Actions | MIT |  |
| @radix-ui/react-compose-refs | 1.1.5 | web 打包 | https://github.com/radix-ui/primitives | radix-ui（Organization） | hadihallak、chancestrickland、mark-workos、npm-workos | GitHub Actions | MIT |  |
| @radix-ui/react-context | 1.2.2 | web 打包 | https://github.com/radix-ui/primitives | radix-ui（Organization） | hadihallak、chancestrickland、mark-workos、npm-workos | GitHub Actions | MIT |  |
| @radix-ui/react-dialog | 1.1.23 | web 打包 | https://github.com/radix-ui/primitives | radix-ui（Organization） | hadihallak、chancestrickland、mark-workos、npm-workos | GitHub Actions | MIT |  |
| @radix-ui/react-dismissable-layer | 1.1.19 | web 打包 | https://github.com/radix-ui/primitives | radix-ui（Organization） | hadihallak、chancestrickland、mark-workos、npm-workos | GitHub Actions | MIT |  |
| @radix-ui/react-focus-guards | 1.1.6 | web 打包 | https://github.com/radix-ui/primitives | radix-ui（Organization） | hadihallak、chancestrickland、mark-workos、npm-workos | GitHub Actions | MIT |  |
| @radix-ui/react-focus-scope | 1.1.16 | web 打包 | https://github.com/radix-ui/primitives | radix-ui（Organization） | hadihallak、chancestrickland、mark-workos、npm-workos | GitHub Actions | MIT |  |
| @radix-ui/react-id | 1.1.4 | web 打包 | https://github.com/radix-ui/primitives | radix-ui（Organization） | hadihallak、chancestrickland、mark-workos、npm-workos | GitHub Actions | MIT |  |
| @radix-ui/react-portal | 1.1.17 | web 打包 | https://github.com/radix-ui/primitives | radix-ui（Organization） | hadihallak、chancestrickland、mark-workos、npm-workos | GitHub Actions | MIT |  |
| @radix-ui/react-presence | 1.1.10 | web 打包 | https://github.com/radix-ui/primitives | radix-ui（Organization） | hadihallak、chancestrickland、mark-workos、npm-workos | GitHub Actions | MIT |  |
| @radix-ui/react-primitive | 2.1.10 | web 打包 | https://github.com/radix-ui/primitives | radix-ui（Organization） | hadihallak、chancestrickland、mark-workos、npm-workos | GitHub Actions | MIT |  |
| @radix-ui/react-slot | 1.3.3 | web 打包 | https://github.com/radix-ui/primitives | radix-ui（Organization） | hadihallak、chancestrickland、mark-workos、npm-workos | GitHub Actions | MIT |  |
| @radix-ui/react-use-callback-ref | 1.1.4 | web 打包 | https://github.com/radix-ui/primitives | radix-ui（Organization） | hadihallak、chancestrickland、mark-workos、npm-workos | GitHub Actions | MIT |  |
| @radix-ui/react-use-controllable-state | 1.2.6 | web 打包 | https://github.com/radix-ui/primitives | radix-ui（Organization） | hadihallak、chancestrickland、mark-workos、npm-workos | GitHub Actions | MIT |  |
| @radix-ui/react-use-effect-event | 0.0.5 | web 打包 | https://github.com/radix-ui/primitives | radix-ui（Organization） | hadihallak、chancestrickland、mark-workos、npm-workos | GitHub Actions | MIT |  |
| @radix-ui/react-use-layout-effect | 1.1.4 | web 打包 | https://github.com/radix-ui/primitives | radix-ui（Organization） | hadihallak、chancestrickland、mark-workos、npm-workos | GitHub Actions | MIT |  |
| @shadcn/react | 0.3.1 | web 打包 | https://github.com/shadcn-ui/ui | shadcn-ui（Organization） | shadcn | GitHub Actions | MIT |  |
| @shikijs/core | 4.4.3 | web 打包 | https://github.com/shikijs/shiki | shikijs（Organization） | antfu、orta、octref | GitHub Actions | MIT |  |
| @shikijs/engine-javascript | 4.4.3 | web 打包 | https://github.com/shikijs/shiki | shikijs（Organization） | antfu、orta、octref | GitHub Actions | MIT |  |
| @shikijs/langs | 4.4.3 | web 打包 | https://github.com/shikijs/shiki | shikijs（Organization） | antfu、orta、octref | GitHub Actions | MIT |  |
| @shikijs/primitive | 4.4.3 | web 打包 | https://github.com/shikijs/shiki | shikijs（Organization） | antfu、orta、octref | GitHub Actions | MIT |  |
| @shikijs/types | 4.4.3 | web 打包 | https://github.com/shikijs/shiki | shikijs（Organization） | antfu、orta、octref | GitHub Actions | MIT |  |
| @shikijs/vscode-textmate | 10.0.2 | web 打包 | https://github.com/shikijs/vscode-textmate | shikijs（Organization） | antfu、orta、octref | antfu | MIT |  |
| @standard-schema/spec | 1.1.0 | npm 閉包 | https://github.com/standard-schema/standard-schema | standard-schema（Organization） | fabian-hiller、colinhacks | fabian-hiller | MIT |  |
| @types/json-schema | 7.0.15 | npm 閉包 | https://github.com/DefinitelyTyped/DefinitelyTyped | DefinitelyTyped（Organization） | types | types | MIT |  |
| @types/node | 24.13.3 | npm 閉包 | https://github.com/DefinitelyTyped/DefinitelyTyped | DefinitelyTyped（Organization） | types | types | MIT |  |
| @vscode/ripgrep-linux-x64 | 1.18.0 | npm 閉包 | https://github.com/microsoft/vscode-ripgrep | microsoft（Organization） | vscode-bot、microsoft1es | microsoft1es | MIT |  |
| @vscode/ripgrep | 1.18.0 | npm 閉包 | https://github.com/microsoft/vscode-ripgrep | microsoft（Organization） | kaimaetzel、lszomoru、alexandrudima、sbatten、joaomoreno.ms、microsoft1es、rebornix、vscode-bot | microsoft1es | MIT |  |
| aria-hidden | 1.2.6 | web 打包 | https://github.com/theKashey/aria-hidden | theKashey（User） | kashey | kashey | MIT |  |
| base64-js | 1.5.1 | npm 閉包 | https://github.com/beatgammit/base64-js | beatgammit（User） | beatgammit、feross | feross | MIT |  |
| braces | 3.0.3 | npm 閉包 | https://github.com/micromatch/braces | micromatch（Organization） | es128、paulmillr、jonschlinkert、doowb | jonschlinkert | MIT |  |
| bytes | 3.1.2 | npm 閉包 | https://github.com/visionmedia/bytes.js | visionmedia（Organization） | tjholowaychuk、dougwilson | dougwilson | MIT |  |
| ccount | 2.0.1 | web 打包 | https://github.com/wooorm/ccount | wooorm（User） | wooorm | wooorm | MIT |  |
| character-entities-html4 | 2.1.0 | web 打包 | https://github.com/wooorm/character-entities-html4 | wooorm（User） | wooorm | wooorm | MIT |  |
| character-entities-legacy | 3.0.0 | web 打包 | https://github.com/wooorm/character-entities-legacy | wooorm（User） | wooorm | wooorm | MIT |  |
| class-variance-authority | 0.7.1 | web 打包 | https://github.com/joe-bell/cva | joe-bell（User） | joebell93 | joebell93 | Apache-2.0 |  |
| clsx | 2.1.1 | web 打包 | https://github.com/lukeed/clsx | lukeed（User） | lukeed | lukeed | MIT |  |
| cmdk | 1.1.1 | web 打包 | https://github.com/pacocoursey/cmdk | dip（Organization） | paco、dipnpm | paco | MIT |  |
| cn | 0.3.0 | web 打包 | https://github.com/shadcn-ui/cn | shadcn-ui（Organization） | shadcn | GitHub Actions | MIT |  |
| comma-separated-tokens | 2.0.3 | web 打包 | https://github.com/wooorm/comma-separated-tokens | wooorm（User） | wooorm | wooorm | MIT |  |
| compressible | 2.0.18 | npm 閉包 | https://github.com/jshttp/compressible | jshttp（Organization） | dougwilson、fishrock123、jongleberry | dougwilson | MIT |  |
| compression | 1.8.2 | npm 閉包 | https://github.com/expressjs/compression | expressjs（Organization） | dougwilson、ulisesgascon、wesleytodd | GitHub Actions | MIT |  |
| content-type | 2.1.0 | npm 閉包 | https://github.com/jshttp/content-type | jshttp（Organization） | ulisesgascon、blakeembrey、dougwilson | blakeembrey | MIT |  |
| cosmokit | 1.8.1 | npm 閉包 | https://github.com/shigma/cosmokit | shigma（User） | shigma | GitHub Actions | MIT |  |
| cross-spawn | 7.0.6 | npm 閉包 | https://github.com/moxystudio/node-cross-spawn | moxystudio（Organization） | satazor | satazor | MIT |  |
| debug | 2.6.9 | npm 閉包 | https://github.com/visionmedia/debug | debug-js（Organization） | thebigredgeek、kolban、tootallnate、tjholowaychuk | tootallnate | MIT |  |
| decode-named-character-reference | 1.3.0 | web 打包 | https://github.com/wooorm/decode-named-character-reference | wooorm（User） | wooorm | wooorm | MIT |  |
| deepagents | 1.13.1 | npm 閉包 | https://github.com/langchain-ai/deepagentsjs | langchain-ai（Organization） | davidduong、basproul、palashshah、nickhuang25 | GitHub Actions | MIT |  |
| destroy | 1.2.0 | npm 閉包 | https://github.com/stream-utils/destroy | stream-utils（Organization） | dougwilson、jongleberry | dougwilson | MIT |  |
| detect-libc | 2.1.2 | npm 閉包 | https://github.com/lovell/detect-libc | lovell（User） | lovell | GitHub Actions | Apache-2.0 |  |
| diff | 9.0.0 | npm 閉包＋web | https://github.com/kpdecker/jsdiff | kpdecker（User） | kpdecker、explodingcabbage | explodingcabbage | BSD-3-Clause |  |
| escape-string-regexp | 5.0.0 | web 打包 | https://github.com/sindresorhus/escape-string-regexp | sindresorhus（User） | sindresorhus | sindresorhus | MIT |  |
| eventemitter3 | 4.0.7 | npm 閉包 | https://github.com/primus/eventemitter3 | primus（Organization） | 3rdeden、lpinca、v1 | lpinca | MIT |  |
| eventemitter3 | 5.0.4 | npm 閉包 | https://github.com/primus/eventemitter3 | primus（Organization） | v1、lpinca、3rdeden | lpinca | MIT |  |
| eventsource-parser | 3.1.1 | npm 閉包 | https://github.com/rexxars/eventsource-parser | rexxars（User） | rexxars | GitHub Actions | MIT |  |
| eventsource | 3.0.7 | npm 閉包 | https://github.com/EventSource/eventsource | EventSource（Organization） | aslakhellesoy、rexxars | rexxars | MIT |  |
| fast-glob | 3.3.3 | npm 閉包 | https://github.com/mrmlnc/fast-glob | mrmlnc（User） | mrmlnc | mrmlnc | MIT |  |
| fastq | 1.20.1 | npm 閉包 | https://github.com/mcollina/fastq | mcollina（User） | matteo.collina | GitHub Actions | ISC |  |
| fill-range | 7.1.1 | npm 閉包 | https://github.com/jonschlinkert/fill-range | jonschlinkert（User） | es128、paulmillr、jonschlinkert、doowb | jonschlinkert | MIT |  |
| get-nonce | 1.0.1 | web 打包 | https://github.com/theKashey/get-nonce | theKashey（User） | kashey | kashey | MIT |  |
| glob-parent | 5.1.2 | npm 閉包 | https://github.com/gulpjs/glob-parent | gulpjs（Organization） | phated、contra、es128、jonschlinkert、doowb | phated | ISC |  |
| gpt-tokenizer | 4.0.0 | npm 閉包 | https://github.com/niieani/gpt-tokenizer | niieani（User） | niieani | GitHub Actions | MIT |  |
| hast-util-to-html | 9.0.5 | web 打包 | https://github.com/syntax-tree/hast-util-to-html | syntax-tree（Organization） | wooorm、kmck | wooorm | MIT |  |
| hast-util-whitespace | 3.0.0 | web 打包 | https://github.com/syntax-tree/hast-util-whitespace | syntax-tree（Organization） | wooorm、kmck | wooorm | MIT |  |
| html-void-elements | 3.0.0 | web 打包 | https://github.com/wooorm/html-void-elements | wooorm（User） | wooorm | wooorm | MIT |  |
| is-extglob | 2.1.1 | npm 閉包 | https://github.com/jonschlinkert/is-extglob | micromatch（Organization） | jonschlinkert | jonschlinkert | MIT |  |
| is-glob | 4.0.3 | npm 閉包 | https://github.com/micromatch/is-glob | micromatch（Organization） | phated、jonschlinkert、doowb | phated | MIT |  |
| is-network-error | 1.3.2 | npm 閉包 | https://github.com/sindresorhus/is-network-error | sindresorhus（User） | sindresorhus | sindresorhus | MIT |  |
| is-number | 7.0.0 | npm 閉包 | https://github.com/jonschlinkert/is-number | jonschlinkert（User） | doowb、jonschlinkert、realityking | jonschlinkert | MIT |  |
| isexe | 2.0.0 | npm 閉包 | https://github.com/isaacs/isexe | isaacs（User） | isaacs | isaacs | ISC |  |
| jose | 6.2.13 | npm 閉包 | https://github.com/panva/jose | panva（User） | panva | GitHub Actions | MIT |  |
| js-tiktoken | 1.0.21 | npm 閉包 | https://github.com/dqbd/tiktoken | dqbd（User） | davidduong | davidduong | MIT |  |
| katex | 0.18.2 | web 打包 | https://github.com/KaTeX/KaTeX | KaTeX（Organization） | xymostech、gagern、kevinbarabash、edemaine、khanacademy、sophiebits、ylemkimon | edemaine | MIT |  |
| langchain | 1.5.10 | npm 閉包 | https://github.com/langchain-ai/langchainjs | langchain-ai（Organization） | hntrl、lc-oss-admin | GitHub Actions | MIT |  |
| langsmith | 0.9.0 | npm 閉包 | https://github.com/langchain-ai/langsmith-sdk | langchain-ai（Organization） | jacoblee93、davidduong、basproul、wifuhi、maddyadams | GitHub Actions | MIT |  |
| lucide-react | 0.552.0 | web 打包 | https://github.com/lucide-icons/lucide | lucide-icons（Organization） | ericfennis | ericfennis | ISC |  |
| mdast-util-find-and-replace | 3.0.2 | web 打包 | https://github.com/syntax-tree/mdast-util-find-and-replace | syntax-tree（Organization） | wooorm、kmck | wooorm | MIT |  |
| mdast-util-from-markdown | 2.0.3 | web 打包 | https://github.com/syntax-tree/mdast-util-from-markdown | syntax-tree（Organization） | wooorm、kmck | wooorm | MIT |  |
| mdast-util-gfm-autolink-literal | 2.0.1 | web 打包 | https://github.com/syntax-tree/mdast-util-gfm-autolink-literal | syntax-tree（Organization） | wooorm、kmck | wooorm | MIT |  |
| mdast-util-gfm-footnote | 2.1.0 | web 打包 | https://github.com/syntax-tree/mdast-util-gfm-footnote | syntax-tree（Organization） | wooorm、kmck | wooorm | MIT |  |
| mdast-util-gfm-strikethrough | 2.0.0 | web 打包 | https://github.com/syntax-tree/mdast-util-gfm-strikethrough | syntax-tree（Organization） | wooorm、kmck | wooorm | MIT |  |
| mdast-util-gfm-table | 2.0.0 | web 打包 | https://github.com/syntax-tree/mdast-util-gfm-table | syntax-tree（Organization） | wooorm、kmck | wooorm | MIT |  |
| mdast-util-gfm-task-list-item | 2.0.0 | web 打包 | https://github.com/syntax-tree/mdast-util-gfm-task-list-item | syntax-tree（Organization） | wooorm、kmck | wooorm | MIT |  |
| mdast-util-gfm | 3.1.0 | web 打包 | https://github.com/syntax-tree/mdast-util-gfm | syntax-tree（Organization） | wooorm、kmck | wooorm | MIT |  |
| mdast-util-math | 3.0.0 | web 打包 | https://github.com/syntax-tree/mdast-util-math | syntax-tree（Organization） | wooorm、kmck | wooorm | MIT |  |
| mdast-util-to-string | 4.0.0 | web 打包 | https://github.com/syntax-tree/mdast-util-to-string | syntax-tree（Organization） | wooorm、kmck | wooorm | MIT |  |
| merge2 | 1.4.1 | npm 閉包 | https://github.com/teambition/merge2 | teambition（Organization） | zensh | zensh | MIT |  |
| micromark-core-commonmark | 2.0.3 | web 打包 | https://github.com/micromark/micromark | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-extension-gfm-autolink-literal | 2.1.0 | web 打包 | https://github.com/micromark/micromark-extension-gfm-autolink-literal | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-extension-gfm-footnote | 2.1.0 | web 打包 | https://github.com/micromark/micromark-extension-gfm-footnote | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-extension-gfm-strikethrough | 2.1.0 | web 打包 | https://github.com/micromark/micromark-extension-gfm-strikethrough | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-extension-gfm-table | 2.1.2 | web 打包 | https://github.com/micromark/micromark-extension-gfm-table | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-extension-gfm-task-list-item | 2.1.0 | web 打包 | https://github.com/micromark/micromark-extension-gfm-task-list-item | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-extension-gfm | 3.0.0 | web 打包 | https://github.com/micromark/micromark-extension-gfm | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-extension-math | 3.1.0 | web 打包 | https://github.com/micromark/micromark-extension-math | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-factory-destination | 2.0.1 | web 打包 | https://github.com/micromark/micromark | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-factory-label | 2.0.1 | web 打包 | https://github.com/micromark/micromark | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-factory-space | 2.0.1 | web 打包 | https://github.com/micromark/micromark | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-factory-title | 2.0.1 | web 打包 | https://github.com/micromark/micromark | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-factory-whitespace | 2.0.1 | web 打包 | https://github.com/micromark/micromark | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-util-character | 2.1.1 | web 打包 | https://github.com/micromark/micromark | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-util-chunked | 2.0.1 | web 打包 | https://github.com/micromark/micromark | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-util-classify-character | 2.0.1 | web 打包 | https://github.com/micromark/micromark | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-util-combine-extensions | 2.0.1 | web 打包 | https://github.com/micromark/micromark | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-util-decode-numeric-character-reference | 2.0.2 | web 打包 | https://github.com/micromark/micromark | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-util-decode-string | 2.0.1 | web 打包 | https://github.com/micromark/micromark | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-util-html-tag-name | 2.0.1 | web 打包 | https://github.com/micromark/micromark | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-util-normalize-identifier | 2.0.1 | web 打包 | https://github.com/micromark/micromark | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-util-resolve-all | 2.0.1 | web 打包 | https://github.com/micromark/micromark | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-util-sanitize-uri | 2.0.1 | web 打包 | https://github.com/micromark/micromark | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-util-subtokenize | 2.1.0 | web 打包 | https://github.com/micromark/micromark | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark-util-symbol | 2.0.1 | web 打包 | https://github.com/micromark/micromark | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromark | 4.0.2 | web 打包 | https://github.com/micromark/micromark | micromark（Organization） | wooorm | wooorm | MIT |  |
| micromatch | 4.0.8 | npm 閉包 | https://github.com/micromatch/micromatch | micromatch（Organization） | es128、paulmillr、jonschlinkert、doowb、danez | doowb | MIT |  |
| mime-db | 1.54.0 | npm 閉包 | https://github.com/jshttp/mime-db | jshttp（Organization） | blakeembrey、wesleytodd、dougwilson | wesleytodd | MIT |  |
| ms | 2.0.0 | npm 閉包 | https://github.com/zeit/ms | vercel（Organization） | leo、rauchg | leo | MIT |  |
| mustache | 4.2.0 | npm 閉包 | https://github.com/janl/mustache.js | janl（User） | jan、dasilvacontin、flipp | flipp | MIT |  |
| negotiator | 0.6.4 | npm 閉包 | https://github.com/jshttp/negotiator | jshttp（Organization） | blakeembrey、wesleytodd、dougwilson、jongleberry | blakeembrey | MIT |  |
| negotiator | 1.1.0 | npm 閉包 | https://github.com/jshttp/negotiator | jshttp（Organization） | ulisesgascon、blakeembrey、wesleytodd、dougwilson、jongleberry | blakeembrey | MIT |  |
| on-headers | 1.1.0 | npm 閉包 | https://github.com/jshttp/on-headers | jshttp（Organization） | ulisesgascon、blakeembrey、dougwilson | ulisesgascon | MIT |  |
| oniguruma-parser | 0.12.2 | web 打包 | https://github.com/slevithan/oniguruma-parser | slevithan（User） | slevithan | slevithan | MIT |  |
| oniguruma-to-es | 4.3.6 | web 打包 | https://github.com/slevithan/oniguruma-to-es | slevithan（User） | slevithan | slevithan | MIT |  |
| openai | 7.5.0 | npm 閉包 | https://github.com/openai/openai-node | openai（Organization） | openai-publisher、tino-openai、dylan-hurd-openai、moustafa-openai、tylersmith-openai、mdangelo-openai、victor-openai、jbeckwith-oai、wadih-openai、atty-openai、tibo-openai、dkundel-openai、mbolin-openai、fouad-openai、easong-openai、aibrahim-openai、apcha-oai、seratch-openai、dschnurr-openai | GitHub Actions | Apache-2.0 |  |
| p-finally | 1.0.0 | npm 閉包 | https://github.com/sindresorhus/p-finally | sindresorhus（User） | sindresorhus | sindresorhus | MIT |  |
| p-queue | 6.6.2 | npm 閉包 | https://github.com/sindresorhus/p-queue | sindresorhus（User） | floatdrop、sindresorhus | sindresorhus | MIT |  |
| p-queue | 9.3.3 | npm 閉包 | https://github.com/sindresorhus/p-queue | sindresorhus（User） | sindresorhus | sindresorhus | MIT |  |
| p-retry | 7.1.1 | npm 閉包 | https://github.com/sindresorhus/p-retry | sindresorhus（User） | sindresorhus | sindresorhus | MIT |  |
| p-timeout | 3.2.0 | npm 閉包 | https://github.com/sindresorhus/p-timeout | sindresorhus（User） | sindresorhus | sindresorhus | MIT |  |
| p-timeout | 7.0.1 | npm 閉包 | https://github.com/sindresorhus/p-timeout | sindresorhus（User） | sindresorhus | sindresorhus | MIT |  |
| path-key | 3.1.1 | npm 閉包 | https://github.com/sindresorhus/path-key | sindresorhus（User） | sindresorhus | sindresorhus | MIT |  |
| picomatch | 2.3.2 | npm 閉包 | https://github.com/micromatch/picomatch | micromatch（Organization） | mrmlnc、jonschlinkert、doowb、danez | danez | MIT |  |
| pkce-challenge | 5.0.1 | npm 閉包 | https://github.com/crouchcd/pkce-challenge | crouchcd（User） | crouchcd | crouchcd | MIT |  |
| property-information | 7.2.0 | web 打包 | https://github.com/wooorm/property-information | wooorm（User） | wooorm | wooorm | MIT |  |
| queue-microtask | 1.2.3 | npm 閉包 | https://github.com/feross/queue-microtask | feross（User） | feross | feross | MIT |  |
| quickjs-emscripten-core | 0.32.0 | npm 閉包 | https://github.com/justjake/quickjs-emscripten | justjake（User） | jitl | jitl | MIT |  |
| quickjs-emscripten | 0.32.0 | npm 閉包 | https://github.com/justjake/quickjs-emscripten | justjake（User） | jitl | jitl | MIT |  |
| react-dom | 19.2.8 | npm 閉包＋web | https://github.com/react/react | react（Organization） | fb、react-bot | GitHub Actions | MIT |  |
| react-remove-scroll-bar | 2.3.8 | web 打包 | https://github.com/theKashey/react-remove-scroll-bar | theKashey（User） | kashey | kashey | MIT |  |
| react-remove-scroll | 2.7.2 | web 打包 | https://github.com/theKashey/react-remove-scroll | theKashey（User） | kashey | kashey | MIT |  |
| react-style-singleton | 2.2.3 | web 打包 | https://github.com/theKashey/react-style-singleton | theKashey（User） | kashey | kashey | MIT |  |
| react | 19.2.8 | npm 閉包＋web | https://github.com/react/react | react（Organization） | fb、react-bot | GitHub Actions | MIT |  |
| regex-recursion | 6.0.2 | web 打包 | https://github.com/slevithan/regex-recursion | slevithan（User） | slevithan | slevithan | MIT |  |
| regex-utilities | 2.3.0 | web 打包 | https://github.com/slevithan/regex-utilities | slevithan（User） | slevithan | slevithan | MIT |  |
| regex | 6.1.0 | web 打包 | https://github.com/slevithan/regex | slevithan（User） | slevithan | slevithan | MIT |  |
| reusify | 1.1.0 | npm 閉包 | https://github.com/mcollina/reusify | mcollina（User） | matteo.collina | matteo.collina | MIT |  |
| run-parallel | 1.2.0 | npm 閉包 | https://github.com/feross/run-parallel | feross（User） | feross | feross | MIT |  |
| safe-buffer | 5.2.1 | npm 閉包 | https://github.com/feross/safe-buffer | feross（User） | feross、mafintosh | feross | MIT |  |
| scheduler | 0.27.0 | npm 閉包＋web | https://github.com/facebook/react | react（Organization） | fb、react-bot | react-bot | MIT |  |
| semver | 7.8.5 | npm 閉包 | https://github.com/npm/node-semver | npm（Organization） | saquibkhan、npm-cli-ops、reggi、owlstronaut | GitHub Actions | ISC |  |
| sharp | 0.35.5 | npm 閉包 | https://github.com/lovell/sharp | lovell（User） | lovell | GitHub Actions | Apache-2.0 |  |
| shebang-command | 2.0.0 | npm 閉包 | https://github.com/kevva/shebang-command | kevva（User） | kevva | kevva | MIT |  |
| shebang-regex | 3.0.0 | npm 閉包 | https://github.com/sindresorhus/shebang-regex | sindresorhus（User） | sindresorhus | sindresorhus | MIT |  |
| sonner | 2.0.8 | web 打包 | https://github.com/emilkowalski/sonner | emilkowalski（User） | emilkowalski | emilkowalski | MIT |  |
| space-separated-tokens | 2.0.2 | web 打包 | https://github.com/wooorm/space-separated-tokens | wooorm（User） | wooorm | wooorm | MIT |  |
| stringify-entities | 4.0.4 | web 打包 | https://github.com/wooorm/stringify-entities | wooorm（User） | wooorm | wooorm | MIT |  |
| tailwindcss | 4.3.3 | web 打包 | https://github.com/tailwindlabs/tailwindcss | tailwindlabs（Organization） | malfaitrobin、adamwathan、reinink | GitHub Actions | MIT |  |
| to-regex-range | 5.0.1 | npm 閉包 | https://github.com/micromatch/to-regex-range | micromatch（Organization） | doowb、jonschlinkert | jonschlinkert | MIT |  |
| tslib | 2.8.1 | web 打包 | https://github.com/Microsoft/tslib | microsoft（Organization） | typescript-bot、weswigham、sanders_n、andrewbranch、minestarks、rbuckton、sheetalkamat、typescript-deploys | typescript-bot | 0BSD |  |
| tw-animate-css | 1.4.0 | web 打包 | https://github.com/Wombosvideo/tw-animate-css | Wombosvideo（User） | wombosvideo | wombosvideo | MIT |  |
| undici-types | 7.18.2 | npm 閉包 | https://github.com/nodejs/undici | nodejs（Organization） | matteo.collina、ethan_arrowood | GitHub Actions | MIT |  |
| undici | 8.12.3 | npm 閉包 | https://github.com/nodejs/undici | nodejs（Organization） | matteo.collina、ronag、ethan_arrowood | GitHub Actions | MIT |  |
| unist-util-is | 6.0.1 | web 打包 | https://github.com/syntax-tree/unist-util-is | syntax-tree（Organization） | wooorm、kmck | wooorm | MIT |  |
| unist-util-stringify-position | 4.0.0 | web 打包 | https://github.com/syntax-tree/unist-util-stringify-position | syntax-tree（Organization） | wooorm、kmck | wooorm | MIT |  |
| unist-util-visit-parents | 6.0.2 | web 打包 | https://github.com/syntax-tree/unist-util-visit-parents | syntax-tree（Organization） | wooorm、kmck | wooorm | MIT |  |
| use-callback-ref | 1.3.3 | web 打包 | https://github.com/theKashey/use-callback-ref | theKashey（User） | kashey | kashey | MIT |  |
| use-sidecar | 1.1.3 | web 打包 | https://github.com/theKashey/use-sidecar | theKashey（User） | kashey | kashey | MIT |  |
| use-sync-external-store | 1.7.0 | web 打包 | https://github.com/react/react | react（Organization） | react-bot | GitHub Actions | MIT |  |
| vary | 1.1.2 | npm 閉包 | https://github.com/jshttp/vary | jshttp（Organization） | dougwilson | dougwilson | MIT |  |
| which | 2.0.2 | npm 閉包 | https://github.com/isaacs/node-which | npm（Organization） | isaacs | isaacs | ISC |  |
| ws | 8.21.3 | npm 閉包 | https://github.com/websockets/ws | websockets（Organization） | lpinca | lpinca | MIT |  |
| yaml | 2.9.1 | npm 閉包 | https://github.com/eemeli/yaml | eemeli（User） | eemeli | eemeli | ISC |  |
| zod | 4.6.7 | npm 閉包 | https://github.com/colinhacks/zod | colinhacks（User） | colinhacks | GitHub Actions | MIT |  |
| zwitch | 2.0.4 | web 打包 | https://github.com/wooorm/zwitch | wooorm（User） | wooorm | wooorm | MIT |  |
| shadcn | 4.21.4 | web vendor | https://github.com/shadcn-ui/ui | shadcn-ui（Organization） | shadcn、npm_bot_shadcn | GitHub Actions | MIT | 只取 tailwind.css |
| solid-glass | 6e8903e494a1 | web vendor | https://github.com/deeplethe/solid-glass | deeplethe（Organization） | WaylandYang、Maya-Kid、Floating-Y | 查不到 | MIT | 維護者欄是 commit 作者；組織成員不公開 |
| @nexus/cordis | 4.0.0-rc.12 | vendor | https://github.com/cordiverse/cordis | cordiverse（Organization） | shigma | GitHub Actions | MIT | 上游 cordis，commit 01b396240ce4；維護者取上游 npm 最新版 |
| @nexus/cordis-plugin-loader | 1.0.0-rc.9 | vendor | https://github.com/cordiverse/cordis | cordiverse（Organization） | shigma | GitHub Actions | MIT | 上游 @cordisjs/plugin-loader，commit 01b396240ce4；維護者取上游 npm 最新版 |
| @nexus/cordis-plugin-include | 1.2.0 | vendor | https://github.com/cordiverse/cordis | cordiverse（Organization） | shigma | GitHub Actions | MIT | 上游 @cordisjs/plugin-include，commit 01b396240ce4；維護者取上游 npm 最新版 |
| @nexus/cordis-plugin-logger-console | 1.0.0 | vendor | https://github.com/cordiverse/cordis | cordiverse（Organization） | shigma | shigma | MIT | 上游 @cordisjs/plugin-logger-console，commit 01b396240ce4；維護者取上游 npm 最新版 |
| enumflags2 | 0.7.12 | crate | https://github.com/meithecatte/enumflags2 | meithecatte（User） | meithecatte | meithecatte | MIT OR Apache-2.0 | 連進執行檔 |
| enumflags2_derive | 0.7.12 | crate | https://github.com/meithecatte/enumflags2 | meithecatte（User） | meithecatte | meithecatte | MIT OR Apache-2.0 | 只在建置時 |
| landlock | 0.4.7 | crate | https://github.com/landlock-lsm/rust-landlock | landlock-lsm（Organization） | l0kod | l0kod | MIT OR Apache-2.0 | 連進執行檔 |
| libc | 0.2.191 | crate | https://github.com/rust-lang/libc | rust-lang（Organization） | rust-lang-owner | 查不到 | MIT OR Apache-2.0 | 連進執行檔 |
| proc-macro2 | 1.0.107 | crate | https://github.com/dtolnay/proc-macro2 | dtolnay（User） | dtolnay | dtolnay | MIT OR Apache-2.0 | 只在建置時 |
| quote | 1.0.47 | crate | https://github.com/dtolnay/quote | dtolnay（User） | dtolnay | dtolnay | MIT OR Apache-2.0 | 只在建置時 |
| syn | 2.0.119 | crate | https://github.com/dtolnay/syn | dtolnay（User） | dtolnay | dtolnay | MIT OR Apache-2.0 | 只在建置時 |
| syn | 3.0.9 | crate | https://github.com/dtolnay/syn | dtolnay（User） | dtolnay | dtolnay | MIT OR Apache-2.0 | 只在建置時 |
| thiserror | 2.0.21 | crate | https://github.com/dtolnay/thiserror | dtolnay（User） | dtolnay | dtolnay | MIT OR Apache-2.0 | 連進執行檔 |
| thiserror-impl | 2.0.21 | crate | https://github.com/dtolnay/thiserror | dtolnay（User） | dtolnay | dtolnay | MIT OR Apache-2.0 | 只在建置時 |
| unicode-ident | 1.0.27 | crate | https://github.com/dtolnay/unicode-ident | dtolnay（User） | dtolnay | dtolnay | (MIT OR Apache-2.0) AND Unicode-3.0 | 只在建置時 |
| llvm-libunwind | 22.1.8 | 工具鏈 | https://github.com/llvm/llvm-project | llvm（Organization） | 查不到 | 查不到 | Apache-2.0 WITH LLVM-exception |  |
| musl | 1.2.5 | 工具鏈 | https://musl.libc.org/ | 查不到 | 查不到 | 查不到 | MIT |  |
| rust-std | 1.98.1 | 工具鏈 | https://github.com/rust-lang/rust | rust-lang（Organization） | 查不到 | 查不到 | MIT OR Apache-2.0 |  |
