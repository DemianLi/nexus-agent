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
| `@nexus/cordis-plugin-logger-console` | `@cordisjs/plugin-logger-console` | [vendor/logger-console](vendor/logger-console/) | MIT |

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
| [`@eslint-community/regexpp`](https://github.com/eslint-community/regexpp) | MIT |
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
| [`compression`](https://github.com/expressjs/compression) | MIT |
| [`cosmokit`](https://github.com/shigma/cosmokit) | MIT |
| [`deepagents`](https://github.com/langchain-ai/deepagentsjs) | MIT |
| [`diff`](https://github.com/kpdecker/jsdiff) | BSD-3-Clause |
| [`gpt-tokenizer`](https://github.com/niieani/gpt-tokenizer) | MIT |
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
| [`negotiator`](https://github.com/jshttp/negotiator) | MIT |
| [`quickjs-emscripten`](https://github.com/justjake/quickjs-emscripten) | MIT |
| [`react`](https://github.com/react/react) | MIT |
| [`react-dom`](https://github.com/react/react) | MIT |
| [`semver`](https://github.com/npm/node-semver) | ISC |
| [`sharp`](https://github.com/lovell/sharp) | Apache-2.0 |
| [`shiki`](https://github.com/shikijs/shiki) | MIT |
| [`sonner`](https://github.com/emilkowalski/sonner) | MIT |
| [`tailwindcss`](https://github.com/tailwindlabs/tailwindcss) | MIT |
| [`tw-animate-css`](https://github.com/Wombosvideo/tw-animate-css) | MIT |
| [`undici`](https://github.com/nodejs/undici) | MIT |
| [`ws`](https://github.com/websockets/ws) | MIT |
| [`yaml`](https://github.com/eemeli/yaml) | ISC |
| [`zod`](https://github.com/colinhacks/zod) | MIT |

## 網頁的字型

`@fontsource-variable/geist`、`@fontsource-variable/geist-mono`、`@fontsource-variable/noto-sans-tc` 宣告 SIL Open Font License 1.1（`OFL-1.1`），不在寬鬆授權的清單上；檢查只對這幾個套件名、而且授權剛好是 `OFL-1.1` 時放行。字型檔（`.woff2`）打包進網頁的 `dist`。

OFL 允許字型跟著軟體一起散布、也允許內嵌，條件是：不能單獨販售字型本身；散布時要附上原本的著作權聲明與 OFL 全文；修改過的字型不能沿用保留的字型名稱。

這個例外的決議記錄：[#1545 issuecomment-6254467463](https://github.com/DemianLi/nexus-agent/issues/1545#issuecomment-6254467463)。

## 內附的原生函式庫

產物內附 [`@img/sharp-libvips-linux-x64`](https://github.com/lovell/sharp-libvips) 1.3.4：[libvips](https://github.com/libvips/libvips) 與它的相依，以預編譯的共享函式庫（`.so`）原樣散布，由 `sharp` 在執行期動態載入，授權是 `LGPL-3.0-or-later`。它內附的各個函式庫與各自的授權，列在產物裡那個套件的 `README.md`。

LGPL 3.0 的全文與它引用的 GPL 3.0 全文放在產物的 [`licenses/LGPL-3.0.txt`](licenses/LGPL-3.0.txt) 與 [`licenses/GPL-3.0.txt`](licenses/GPL-3.0.txt)。

引進的決定記在 [#1827 D22](https://github.com/DemianLi/nexus-agent/issues/1827)。

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
| [`@types/compression`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT |
| [`@types/js-yaml`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT |
| [`@types/mdast`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT |
| [`@types/negotiator`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT |
| [`@types/node`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT |
| [`@types/react`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT |
| [`@types/react-dom`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT |
| [`@types/semver`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT |
| [`@types/spdx-expression-parse`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT |
| [`@types/ws`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT |
| [`@vitejs/plugin-react`](https://github.com/vitejs/vite-plugin-react) | MIT |
| [`ajv`](https://github.com/ajv-validator/ajv) | MIT |
| [`axe-core`](https://github.com/dequelabs/axe-core) | MPL-2.0 |
| [`colorjs.io`](https://github.com/color-js/color.js) | MIT |
| [`eslint`](https://github.com/eslint/eslint) | MIT |
| [`eslint-config-prettier`](https://github.com/prettier/eslint-config-prettier) | MIT |
| [`js-tiktoken`](https://github.com/dqbd/tiktoken) | MIT |
| [`js-yaml`](https://github.com/nodeca/js-yaml) | MIT |
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

## 沙箱 spawner 連進去的程式碼

`native/sandbox-spawner/` 編成 Linux 產物裡的 `native/nexus-sandbox-spawner`（[#1946](https://github.com/DemianLi/nexus-agent/issues/1946)），靜態連結 musl。下表是 [`native/sandbox-spawner/Cargo.lock`](native/sandbox-spawner/Cargo.lock) 的每一個外部 crate，加上 Rust 的標準函式庫與工具鏈自帶、跟著它連進執行檔的 C 函式庫。連進執行檔的每一項，授權全文放在產物的 `licenses/sandbox-spawner/`；標準函式庫自己內附的第三方程式碼列在那裡的 `rust-std/COPYRIGHT-library.html`；C 函式庫的授權原文也附在本節最後。

| crate | 版本 | 授權 | 連進執行檔 |
| --- | --- | --- | --- |
| [Rust 標準函式庫](https://github.com/rust-lang/rust) | 1.98.1 | MIT OR Apache-2.0 | 是 |
| [llvm-libunwind](https://github.com/llvm/llvm-project) | 22.1.8 | Apache-2.0 WITH LLVM-exception | 是 |
| [musl](https://musl.libc.org/) | 1.2.5 | MIT | 是 |
| [`enumflags2`](https://github.com/meithecatte/enumflags2) | 0.7.12 | MIT OR Apache-2.0 | 是 |
| [`enumflags2_derive`](https://github.com/meithecatte/enumflags2) | 0.7.12 | MIT OR Apache-2.0 | 否，只在編譯期跑 |
| [`landlock`](https://github.com/landlock-lsm/rust-landlock) | 0.4.7 | MIT OR Apache-2.0 | 是 |
| [`libc`](https://github.com/rust-lang/libc) | 0.2.191 | MIT OR Apache-2.0 | 是 |
| [`proc-macro2`](https://github.com/dtolnay/proc-macro2) | 1.0.107 | MIT OR Apache-2.0 | 否，只在編譯期跑 |
| [`quote`](https://github.com/dtolnay/quote) | 1.0.47 | MIT OR Apache-2.0 | 否，只在編譯期跑 |
| [`syn`](https://github.com/dtolnay/syn) | 2.0.119、3.0.9 | MIT OR Apache-2.0 | 否，只在編譯期跑 |
| [`thiserror`](https://github.com/dtolnay/thiserror) | 2.0.21 | MIT OR Apache-2.0 | 是 |
| [`thiserror-impl`](https://github.com/dtolnay/thiserror) | 2.0.21 | MIT OR Apache-2.0 | 否，只在編譯期跑 |
| [`unicode-ident`](https://github.com/dtolnay/unicode-ident) | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 | 否，只在編譯期跑 |

`unicode-ident`（(MIT OR Apache-2.0) AND Unicode-3.0） 只在編譯期跑，程式碼不會連進執行檔。

### llvm-libunwind 22.1.8：`LICENSE.TXT`

````text
==============================================================================
The LLVM Project is under the Apache License v2.0 with LLVM Exceptions:
==============================================================================

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

    TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

    1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

    2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

    3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

    4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

    5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

    6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

    7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

    8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

    9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

    END OF TERMS AND CONDITIONS

    APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

    Copyright [yyyy] [name of copyright owner]

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.


---- LLVM Exceptions to the Apache 2.0 License ----

As an exception, if, as a result of your compiling your source code, portions
of this Software are embedded into an Object form of such source code, you
may redistribute such embedded portions in such Object form without complying
with the conditions of Sections 4(a), 4(b) and 4(d) of the License.

In addition, if you combine or link compiled forms of this Software with
software that is licensed under the GPLv2 ("Combined Software") and if a
court of competent jurisdiction determines that the patent provision (Section
3), the indemnity provision (Section 9) or other Section of the License
conflicts with the conditions of the GPLv2, you may retroactively and
prospectively choose to deem waived or otherwise exclude such Section(s) of
the License, but only in their entirety and only with respect to the Combined
Software.

==============================================================================
Software from third parties included in the LLVM Project:
==============================================================================
The LLVM Project contains third party software which is under different license
terms. All such code will be identified clearly using at least one of two
mechanisms:
1) It will be in a separate directory tree with its own `LICENSE.txt` or
   `LICENSE` file at the top containing the specific license and restrictions
   which apply to that software, or
2) It will contain specific license and restriction terms at the top of every
   file.

==============================================================================
Legacy LLVM License (https://llvm.org/docs/DeveloperPolicy.html#legacy):
==============================================================================

The libunwind library is dual licensed under both the University of Illinois
"BSD-Like" license and the MIT license.  As a user of this code you may choose
to use it under either license.  As a contributor, you agree to allow your code
to be used under both.

Full text of the relevant licenses is included below.

==============================================================================

University of Illinois/NCSA
Open Source License

Copyright (c) 2009-2019 by the contributors listed in CREDITS.TXT

All rights reserved.

Developed by:

    LLVM Team

    University of Illinois at Urbana-Champaign

    http://llvm.org

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal with
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimers.

    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimers in the
      documentation and/or other materials provided with the distribution.

    * Neither the names of the LLVM Team, University of Illinois at
      Urbana-Champaign, nor the names of its contributors may be used to
      endorse or promote products derived from this Software without specific
      prior written permission.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
CONTRIBUTORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS WITH THE
SOFTWARE.

==============================================================================

Copyright (c) 2009-2014 by the contributors listed in CREDITS.TXT

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
````

### musl 1.2.5：`COPYRIGHT`

````text
musl as a whole is licensed under the following standard MIT license:

----------------------------------------------------------------------
Copyright © 2005-2020 Rich Felker, et al.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
----------------------------------------------------------------------

Authors/contributors include:

A. Wilcox
Ada Worcester
Alex Dowad
Alex Suykov
Alexander Monakov
Andre McCurdy
Andrew Kelley
Anthony G. Basile
Aric Belsito
Arvid Picciani
Bartosz Brachaczek
Benjamin Peterson
Bobby Bingham
Boris Brezillon
Brent Cook
Chris Spiegel
Clément Vasseur
Daniel Micay
Daniel Sabogal
Daurnimator
David Carlier
David Edelsohn
Denys Vlasenko
Dmitry Ivanov
Dmitry V. Levin
Drew DeVault
Emil Renner Berthing
Fangrui Song
Felix Fietkau
Felix Janda
Gianluca Anzolin
Hauke Mehrtens
He X
Hiltjo Posthuma
Isaac Dunham
Jaydeep Patil
Jens Gustedt
Jeremy Huntwork
Jo-Philipp Wich
Joakim Sindholt
John Spencer
Julien Ramseier
Justin Cormack
Kaarle Ritvanen
Khem Raj
Kylie McClain
Leah Neukirchen
Luca Barbato
Luka Perkov
M Farkas-Dyck (Strake)
Mahesh Bodapati
Markus Wichmann
Masanori Ogino
Michael Clark
Michael Forney
Mikhail Kremnyov
Natanael Copa
Nicholas J. Kain
orc
Pascal Cuoq
Patrick Oppenlander
Petr Hosek
Petr Skocik
Pierre Carrier
Reini Urban
Rich Felker
Richard Pennington
Ryan Fairfax
Samuel Holland
Segev Finer
Shiz
sin
Solar Designer
Stefan Kristiansson
Stefan O'Rear
Szabolcs Nagy
Timo Teräs
Trutz Behn
Valentin Ochs
Will Dietz
William Haddon
William Pitcock

Portions of this software are derived from third-party works licensed
under terms compatible with the above MIT license:

The TRE regular expression implementation (src/regex/reg* and
src/regex/tre*) is Copyright © 2001-2008 Ville Laurikari and licensed
under a 2-clause BSD license (license text in the source files). The
included version has been heavily modified by Rich Felker in 2012, in
the interests of size, simplicity, and namespace cleanliness.

Much of the math library code (src/math/* and src/complex/*) is
Copyright © 1993,2004 Sun Microsystems or
Copyright © 2003-2011 David Schultz or
Copyright © 2003-2009 Steven G. Kargl or
Copyright © 2003-2009 Bruce D. Evans or
Copyright © 2008 Stephen L. Moshier or
Copyright © 2017-2018 Arm Limited
and labelled as such in comments in the individual source files. All
have been licensed under extremely permissive terms.

The ARM memcpy code (src/string/arm/memcpy.S) is Copyright © 2008
The Android Open Source Project and is licensed under a two-clause BSD
license. It was taken from Bionic libc, used on Android.

The AArch64 memcpy and memset code (src/string/aarch64/*) are
Copyright © 1999-2019, Arm Limited.

The implementation of DES for crypt (src/crypt/crypt_des.c) is
Copyright © 1994 David Burren. It is licensed under a BSD license.

The implementation of blowfish crypt (src/crypt/crypt_blowfish.c) was
originally written by Solar Designer and placed into the public
domain. The code also comes with a fallback permissive license for use
in jurisdictions that may not recognize the public domain.

The smoothsort implementation (src/stdlib/qsort.c) is Copyright © 2011
Valentin Ochs and is licensed under an MIT-style license.

The x86_64 port was written by Nicholas J. Kain and is licensed under
the standard MIT terms.

The mips and microblaze ports were originally written by Richard
Pennington for use in the ellcc project. The original code was adapted
by Rich Felker for build system and code conventions during upstream
integration. It is licensed under the standard MIT terms.

The mips64 port was contributed by Imagination Technologies and is
licensed under the standard MIT terms.

The powerpc port was also originally written by Richard Pennington,
and later supplemented and integrated by John Spencer. It is licensed
under the standard MIT terms.

All other files which have no copyright comments are original works
produced specifically for use as part of this library, written either
by Rich Felker, the main author of the library, or by one or more
contibutors listed above. Details on authorship of individual files
can be found in the git version control history of the project. The
omission of copyright and license comments in each file is in the
interest of source tree size.

In addition, permission is hereby granted for all public header files
(include/* and arch/*/bits/*) and crt files intended to be linked into
applications (crt/*, ldso/dlstart.c, and arch/*/crt_arch.h) to omit
the copyright notice and permission notice otherwise required by the
license, and to use these files without any requirement of
attribution. These files include substantial contributions from:

Bobby Bingham
John Spencer
Nicholas J. Kain
Rich Felker
Richard Pennington
Stefan Kristiansson
Szabolcs Nagy

all of whom have explicitly granted such permission.

This file previously contained text expressing a belief that most of
the files covered by the above exception were sufficiently trivial not
to be subject to copyright, resulting in confusion over whether it
negated the permissions granted in the license. In the spirit of
permissive licensing, and of not having licensing issues being an
obstacle to adoption, that text has been removed.
````
