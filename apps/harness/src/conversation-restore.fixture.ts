/**
 * 一顆把每一次模型請求的訊息串記下來的 middleware plugin。
 *
 * **它證的是入口真的把對話灌回去了**（[#306](https://github.com/DemianLi/nexus-agent/issues/306)）：`runCli` 與
 * `runServe` 都不交出 agent 與模型，這條路離開行程的只有 stdout 與日誌，而「模型記得」只看得到模型收到了什麼。
 * 記在模組層：測試 import 同一個模組，讀的是同一份。
 *
 * **這是單顆 plugin，不是清單**（[#455](https://github.com/DemianLi/nexus-agent/issues/455)）：旁邊那份
 * patch 檔把它 `insert` 到出貨清單上。echo 本來就在出貨清單裡，所以不再自己列一份。
 */

import type { BaseMessage } from '@langchain/core/messages';
import type { NexusPlugin } from '@nexus/core';
import { createMiddleware } from 'langchain';

/** 依發生順序的每一次模型請求。測試自己清。 */
export const seenRequests: (readonly BaseMessage[])[] = [];

const recorder: NexusPlugin = {
  name: 'request-recorder',
  apply(registry) {
    registry.middleware.use(
      createMiddleware({
        name: 'RequestRecorder',
        wrapModelCall: (request, handler) => {
          seenRequests.push([...request.messages]);
          return handler(request);
        },
      }),
    );
  },
};

export default recorder;
