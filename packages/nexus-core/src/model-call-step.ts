/**
 * 環繞一次模型呼叫的一步（[#2416](https://github.com/DemianLi/nexus-agent/issues/2416)）：一步拿到這次模型請求與往內一層，
 * 可以改了請求再往內交、往內交好幾次（摘要器超窗時換保留量重走），或看往內交回來的結果再決定回什麼。
 *
 * 請求與結果都是不透明的，一步的簽名不帶 LangChain 型別；摘要器那一步內部仍用 `BaseMessage` 與 `model.invoke`，TODO([#2363](https://github.com/DemianLi/nexus-agent/issues/2363))。
 *
 * **wrapModelCall 由登記的那一份造出來**（{@link withModelCallStep}）：同一步既造那顆的 `wrapModelCall`，也登記給 native，所以兩者
 * 分不開。native 的 root 在模型那一串（`native-loop/agent.ts` 的 `#modelCells`）直接呼叫 {@link wrapModelCallFromStep} 造的那一支，
 * 不經那顆的 `wrapModelCall`；`langgraph` 與子代理照舊經 `wrapModelCall`。轉接是同步的，中間沒有 `await`。
 *
 * @module
 */

/** 一次模型請求，不看型別。 */
export type ModelCallRequest = object;

/** 往內交一層，回內層的結果。沒有防重入：呼叫兩次，內層就跑兩次。 */
export type ModelCallNext = (request: ModelCallRequest) => unknown;

/** 環繞一次模型呼叫的一步。 */
export type ModelCallStep = (request: ModelCallRequest, next: ModelCallNext) => unknown;

/**
 * 把一步轉成 `wrapModelCall`：`handler` 就是那一步的 `next`。
 *
 * @param step - 這一步。
 * @returns 可以放進 `wrapModelCall` 的函式。
 */
export function wrapModelCallFromStep<Request extends ModelCallRequest, Result>(
  step: ModelCallStep,
): (request: Request, handler: (request: Request) => Result) => Result {
  return (request, handler) => step(request, handler as ModelCallNext) as Result;
}

const registeredSteps = new WeakMap<object, ModelCallStep>();

/**
 * 用 `step` 造 `wrapModelCall` 交給 `build`，再把同一步登記在 `build` 造出來的那顆上（{@link modelCallStepOf}）。
 * TODO([#2363](https://github.com/DemianLi/nexus-agent/issues/2363))：`langgraph` 那條路徑拿掉、內建不再造成 middleware 時收掉。
 *
 * @param step - 這一步。
 * @param build - 拿 `wrapModelCall` 造那顆 middleware；回的那顆要用收到的這支當 `wrapModelCall`，native 直接呼叫的那一步才跟經
 *   `wrapModelCall` 的是同一份。
 * @returns `build` 造的那顆。
 * @throws {Error} `build` 回的那顆的 `wrapModelCall` 不是收到的那支。
 */
export function withModelCallStep<M extends object>(
  step: ModelCallStep,
  build: (wrapModelCall: (request: never, handler: never) => unknown) => M,
): M {
  const wrapModelCall = wrapModelCallFromStep(step);
  const middleware = build(wrapModelCall as never);
  if ((middleware as { wrapModelCall?: unknown }).wrapModelCall !== wrapModelCall) {
    const name = (middleware as { name?: unknown }).name;
    throw new Error(
      `middleware "${String(name)}" 的 wrapModelCall 不是 withModelCallStep 交給 build 的那支：native 直接呼叫的那一步會跟它不一樣`,
    );
  }
  registeredSteps.set(middleware, step);
  return middleware;
}

/**
 * 這顆 middleware 登記的環繞步；沒登記是 `undefined`。
 * TODO([#2363](https://github.com/DemianLi/nexus-agent/issues/2363))：`langgraph` 那條路徑拿掉、內建不再造成 middleware 時收掉。
 *
 * @param middleware - 那一顆，照身分查：複製出來的物件查不到。
 * @returns 那一步。
 */
export function modelCallStepOf(middleware: object): ModelCallStep | undefined {
  return registeredSteps.get(middleware);
}
