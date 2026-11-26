/**
 * `copy_file`：伺服端照位元組把一個檔複製到還不存在的路徑（[#2289](https://github.com/DemianLi/nexus-agent/issues/2289)）。
 *
 * 模型「讀進來再整檔寫出去」會把內容轉抄壞：出廠模型去掉 `read_file` 的行號時連開頭空白一起剝。複製交給伺服端做，內容不經模型。
 *
 * - 來源與目的地各自照路由交給子 backend 的兩半（`@nexus/core` 的 `copyFileOf`）；工作區、共用區、附件之間都能複製，唯讀的那幾格只能當來源。
 * - 目的地已經存在就拒絕，不覆蓋、不搬檔。
 * - 寫入與 `write_file` 走同一道 fence：唯讀、根外、保留的地方、`permissions` 規則照擋，被擋下時的升級也是同一條路。
 * - 發佈之前核對大小與 sha256，對不上就不發佈（`ContainedFilesystemBackend` 的 `[COPY_INTO]`）。
 * - 成功時把來源、目的地、位元組數、sha256 記進 `tool/result` 的 `meta`，`workspace-changes` 也照這幾格記。
 *
 * 只在有工作區（`agent-factory.ts` 的組裝清單判）、而且 `tool-fs` 沒關掉寫檔（{@link copyFileEntry}）時註冊：沒有工作區時 default 是記憶體，沒有位元組可以照抄。
 *
 * @module
 */

import { tool } from '@langchain/core/tools';
import { copyFileOf, putToolResultMeta } from '@nexus/core';
import type { FsService, PluginEntry } from '@nexus/core';
import type { AnyBackendProtocol } from 'deepagents';
import { z } from 'zod';

import { TOOL_FS_SERVICE } from './settings/tool-fs.js';

/** 工具名。 */
export const COPY_FILE_TOOL_NAME = 'copy_file';

/** 成功時寫進 `tool/result` 的 `meta`。 */
export interface CopyFileMeta {
  readonly operation: 'copy';
  /** 模型給的來源路徑。 */
  readonly source: string;
  /** 目的地的虛擬路徑（canonicalize 之後）。 */
  readonly destination: string;
  readonly bytes: number;
  /** 小寫十六進位。 */
  readonly sha256: string;
}

/** 關來源出的錯：不改這一次的結果，只留一行給伺服器日誌。core 同步叫它、不等它，所以它自己不能拋。 */
function logCloseError(from: string): (error: unknown) => void {
  return (error) => {
    try {
      process.stderr.write(
        `copy_file：來源關不掉（${from}）：${error instanceof Error ? error.message : String(error)}\n`,
      );
    } catch {
      // 標準錯誤也寫不出去時沒有別的地方可以記；這次複製的結果照舊交給模型。
    }
  };
}

const schema = z.object({
  source_path: z.string().describe('Path of the existing file to copy.'),
  destination_path: z.string().describe('Path of the new file. Must not exist yet.'),
});

/**
 * 建工具。
 *
 * @param backendOf - 被叫的那一刻折出來的 backend（這次組裝的 fs 把手）。
 */
export function createCopyFileTool(backendOf: () => AnyBackendProtocol | undefined) {
  return tool(
    async ({ source_path, destination_path }: z.infer<typeof schema>): Promise<string> => {
      const backend = backendOf();
      if (backend === undefined) throw new Error('copy_file requires a filesystem');
      const result = await copyFileOf(
        backend,
        source_path,
        destination_path,
        logCloseError(source_path),
      );
      if ('error' in result) {
        throw new Error(
          result.exists === true
            ? `${result.error}. Choose a new path, or use edit_file to change the existing file.`
            : result.error,
        );
      }
      const { path, bytes, sha256 } = result;
      if (path === undefined || bytes === undefined || sha256 === undefined) {
        throw new Error(`Error copying '${source_path}': the copy did not report its result`);
      }
      const meta: CopyFileMeta = {
        operation: 'copy',
        source: source_path,
        destination: path,
        bytes,
        sha256,
      };
      putToolResultMeta(COPY_FILE_TOOL_NAME, meta);
      return `Copied ${source_path} to ${path} (${bytes} bytes, sha256 ${sha256})`;
    },
    {
      name: COPY_FILE_TOOL_NAME,
      description:
        'Copy an existing file to a new path byte for byte, without retyping its content. Use this instead of read_file ' +
        'followed by write_file when the new file should have the same content. The destination must not exist yet.',
      schema,
    },
  );
}

/**
 * 掛 `copy_file` 的條目。排在出貨清單之後，讀得到 `tool-fs` 那一列提供的開關：`write: false` 時不註冊，跟 `write_file` 一起關。
 *
 * @param fs - 這次組裝的 fs 把手；工具被叫時才讀它的 backend。
 */
export function copyFileEntry(fs: FsService): PluginEntry {
  return {
    plugin: {
      name: 'copy-file',
      apply: (registry) => {
        if (registry.services.get(TOOL_FS_SERVICE)?.write === false) return;
        registry.tools.register(createCopyFileTool(() => fs.backend()));
      },
    },
  };
}
