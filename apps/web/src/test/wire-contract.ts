/**
 * 契約先合、實作還沒做的 wire 方法（#723／#732／#437／#633）：假 client 沒有接這幾個，回 `not_supported`，同 server 還沒實作時的樣子。
 *
 * **只能用 spread 放進 `WireClient` 字面值**（`...UNWIRED_WIRE_CONTRACT`），不要逐項寫在字面值上：逐項寫的話，
 * `@nexus/wire` 還沒有這幾個方法的那棵樹會報「多餘屬性」，契約 PR 與這邊就不能分兩張合。
 * 故意不標型別，理由同上——標成 `Pick<WireClient, …>` 在舊樹上不存在那幾個鍵。
 */
const NOT_SUPPORTED = { kind: 'rejected' as const, code: 'not_supported', message: '這一檔沒有接' };

export const UNWIRED_WIRE_CONTRACT = {
  modelCatalog: async () => NOT_SUPPORTED,
  selectModel: async () => NOT_SUPPORTED,
  permissionCatalog: async () => NOT_SUPPORTED,
  uploadFile: async () => NOT_SUPPORTED,
  threadPin: async () => NOT_SUPPORTED,
  threadUnpin: async () => NOT_SUPPORTED,
  threadArchive: async () => NOT_SUPPORTED,
  threadUnarchive: async () => NOT_SUPPORTED,
  threadRename: async () => NOT_SUPPORTED,
  subagentList: async () => NOT_SUPPORTED,
};
