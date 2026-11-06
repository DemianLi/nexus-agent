/**
 * 自訂元素 `<nexus-chat>`（#2366，地圖 #2365 第 1、6、7、11 點）：宿主頁放一個元素就有一個對話框，不用 iframe。
 *
 * - **Shadow DOM（open）**：樣式不外洩（`@font-face`、`@property` 例外，見下），宿主頁的樣式也進不來。shadow root 裡最外層是 `.nexus-root`（token、亮暗），
 *   裡面是 `.nexus-app`（container query 的容器）與浮層的掛載點（`lib/portal-container.ts`）。掛載點不放在容器裡：
 *   `container-type` 會讓 `position: fixed` 的浮層以容器為準。
 * - **屬性**：`theme` 是 `light`／`dark`／`auto`（預設 `auto`，跟系統）；`context` 是情境標籤的字。`context` 也是 property，
 *   收字串或 `{ label }`（`context.ts`）。`hostTools` 只是 property（#2374，`host-tools.ts`）：宿主頁宣告的工具，模型叫到時元素發
 *   `nexus-host-tool` 事件。宿主頁在元素升級之前就設好的 property 也收得到。
 * - **不碰宿主頁**：亮暗掛在 `.nexus-root` 上，不改 `<html>`；記住上一條 thread 用自己的鍵（`embedded-chat.tsx`）。只有
 *   `@font-face` 與 `@property` 放進宿主頁的 `<head>`，shadow root 裡的這兩種規則 Chrome 不認（`embed-shadow-css.ts`）。
 * - **換票登入**：`signIn(ticket)` 兌換宿主系統後端換來的登入票（#2370，`sign-in.ts`）。成功之後清掉記著的上一條、下行改開新的 socket
 *   （cookie 定在升級當下），改接 serve 回的那一條，沒有就開新的；之後只認換票帶來的，不再讀寫記著的那一條（`embedded-chat.tsx`）。
 * - 元素拿掉就卸掉 React（下行跟著關）；同一個 tick 裡搬到別處（先拿掉再放回去）不卸。
 *
 * @module
 */
import type { HostToolDeclaration, WireClient } from '@nexus/wire';
import { EMBED_PATH_PREFIX } from '@nexus/wire';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';

import { agentBaseUrl, createAgentConnection } from '@/lib/agent';
import type { AgentConnection } from '@/lib/agent';
import { PortalContainerContext } from '@/lib/portal-container';
import { forgetThread } from '@/lib/remembered-thread';
import { systemDarkQuery } from '@/lib/theme';
import { randomUuid } from '@/lib/uuid';

import { SHADOW_CONTAINER_NAME, SHADOW_ROOT_CLASS } from '../../embed-shadow-css';
import { parseContext } from './context';
import type { NexusChatContext } from './context';
import { EMBED_THREAD_KEY, EmbeddedChat } from './embedded-chat';
import type { EmbedSignIn } from './embedded-chat';
import { HOST_TOOL_EVENT, parseHostTools } from './host-tools';
import type { NexusHostToolDetail } from './host-tools';
import { redeemTicket } from './sign-in';
import { themeOverrides } from './theme-tokens';

export const ELEMENT_NAME = 'nexus-chat';

/** 放進宿主頁 `<head>` 的那份樣式的 id：同一頁放幾個元素都只放一次。 */
export const DOCUMENT_STYLE_ID = 'nexus-chat-document-styles';

export type NexusChatTheme = 'light' | 'dark' | 'auto';

export interface NexusChatStyles {
  /** 放進 shadow root 的。 */
  readonly shadow: string;
  /** 放進宿主頁 `<head>` 的（`@font-face`、`@property`）。 */
  readonly document: string;
}

export interface DefineOptions {
  readonly styles: NexusChatStyles;
  /** 注入用；省略就是打 `scriptUrl` 所在目錄底下 `/embed` 的 client（#2382、#2426）。每個元素一個。注入的 client 換票之後不換 socket。 */
  readonly createClient?: () => WireClient;
  /** 注入用：`signIn` 兌換登入票打的 `fetch`。省略是全域的。 */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * 從哪個網址算 agent 的位置（client、`/livez` 探測、交付物下載都用它）；省略是這支模組自己的網址，建置後就是 `embed.js`。
   * 元件跑在宿主頁上，`document.baseURI` 是宿主頁的，不能拿來用（#2426）。測試裡的模組網址是 `file:`，要另外給。
   */
  readonly scriptUrl?: string;
}

/** 元素自己的版面：填滿父容器，斷點跟著 `.nexus-app` 的寬度走。 */
const ELEMENT_CSS = `:host{display:block;inline-size:100%;block-size:100%}
.${SHADOW_ROOT_CLASS}{block-size:100%}
.nexus-app{container:${SHADOW_CONTAINER_NAME} / inline-size;block-size:100%}`;

function parseTheme(value: string | null): NexusChatTheme {
  return value === 'light' || value === 'dark' ? value : 'auto';
}

/** 註冊 `<nexus-chat>`；已經註冊過就什麼都不做（同一頁載入兩次 `embed.js`）。 */
export function defineNexusChat({
  styles,
  scriptUrl = import.meta.url,
  createClient,
  fetch,
}: DefineOptions): void {
  if (customElements.get(ELEMENT_NAME) !== undefined) return;
  const baseUrl = agentBaseUrl(scriptUrl);
  const makeConnection = (): AgentConnection =>
    createClient === undefined
      ? createAgentConnection({ baseUrl, routePrefix: EMBED_PATH_PREFIX })
      : { client: createClient(), renewStreams: () => {} };

  // 型別對著給宿主頁的那份（`nexus-chat.d.ts`），實作跟公開的形狀對不上就編不過。
  class ChatElement extends HTMLElement implements NexusChatElement {
    static readonly observedAttributes = ['theme', 'context'];

    readonly #root: HTMLDivElement;
    readonly #app: HTMLDivElement;
    readonly #portal: HTMLDivElement;
    #react: Root | undefined;
    #connection: AgentConnection | undefined;
    #signIn: EmbedSignIn | undefined;
    #context: NexusChatContext | undefined;
    #hostTools: readonly HostToolDeclaration[] | undefined;
    #overrides: readonly string[] = [];
    #unwatchSystem: (() => void) | undefined;

    constructor() {
      super();
      const shadow = this.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `${styles.shadow}\n${ELEMENT_CSS}`;
      this.#root = document.createElement('div');
      this.#root.className = SHADOW_ROOT_CLASS;
      this.#app = document.createElement('div');
      this.#app.className = 'nexus-app';
      this.#portal = document.createElement('div');
      this.#portal.dataset.nexusPortal = '';
      this.#root.append(this.#app, this.#portal);
      shadow.append(style, this.#root);
    }

    get context(): NexusChatContext | null {
      return this.#context ?? null;
    }

    set context(value: unknown) {
      const parsed = parseContext(value);
      if (parsed === 'invalid') {
        console.warn('<nexus-chat> 的 context 要是字串或 { label: string }，這次的值不收：', value);
        return;
      }
      this.#context = parsed;
      this.#render();
    }

    get hostTools(): readonly HostToolDeclaration[] | null {
      return this.#hostTools ?? null;
    }

    set hostTools(value: unknown) {
      const parsed = parseHostTools(value);
      if (parsed !== undefined && 'problem' in parsed) {
        console.warn(`<nexus-chat> 的 hostTools 不收：${parsed.problem}。這次的值：`, value);
        return;
      }
      this.#hostTools = parsed;
      this.#render();
    }

    connectedCallback() {
      // 升級之前宿主頁直接設在實例上的 property 會蓋住 class 的 setter：拿下來重設一次。
      for (const key of ['context', 'hostTools'] as const) {
        if (!Object.hasOwn(this, key)) continue;
        const value: unknown = (this as { [K in typeof key]?: unknown })[key];
        delete (this as { [K in typeof key]?: unknown })[key];
        this[key] = value as never;
      }
      if (document.getElementById(DOCUMENT_STYLE_ID) === null) {
        const style = document.createElement('style');
        style.id = DOCUMENT_STYLE_ID;
        style.textContent = styles.document;
        document.head.append(style);
      }
      this.#applyTheme();
      if (this.#react === undefined) {
        this.#connection ??= makeConnection();
        this.#react = createRoot(this.#app);
      }
      this.#render();
    }

    disconnectedCallback() {
      queueMicrotask(() => {
        if (this.isConnected) return;
        this.#unwatchSystem?.();
        this.#unwatchSystem = undefined;
        this.#react?.unmount();
        this.#react = undefined;
      });
    }

    attributeChangedCallback(name: string, _old: string | null, value: string | null) {
      if (name === 'theme') {
        if (this.isConnected) this.#applyTheme();
        return;
      }
      this.context = value;
    }

    async signIn(ticket: string): Promise<{ readonly expiresAt: number }> {
      const redeemed = await redeemTicket(baseUrl, ticket, fetch);
      forgetThread(EMBED_THREAD_KEY);
      this.#connection?.renewStreams();
      this.#signIn = {
        seq: (this.#signIn?.seq ?? 0) + 1,
        threadId: redeemed.threadId ?? randomUuid(),
      };
      this.#render();
      return { expiresAt: redeemed.expiresAt };
    }

    #render() {
      const client = this.#connection?.client;
      if (this.#react === undefined || client === undefined) return;
      this.#react.render(
        <StrictMode>
          <PortalContainerContext.Provider value={this.#portal}>
            <EmbeddedChat
              agentBaseUrl={baseUrl}
              client={client}
              context={this.#context}
              hostTools={this.#hostTools}
              onHostCall={this.#handToHost}
              signIn={this.#signIn}
            />
          </PortalContainerContext.Provider>
        </StrictMode>,
      );
    }

    readonly #handToHost = (detail: NexusHostToolDetail) => {
      this.dispatchEvent(new CustomEvent(HOST_TOOL_EVENT, { detail }));
    };

    #applyTheme() {
      const theme = parseTheme(this.getAttribute('theme'));
      this.#unwatchSystem?.();
      this.#unwatchSystem = undefined;
      if (theme === 'auto') {
        const query = systemDarkQuery();
        const onChange = () => this.#paint(query?.matches === true);
        query?.addEventListener('change', onChange);
        this.#unwatchSystem = () => query?.removeEventListener('change', onChange);
        this.#paint(query?.matches === true);
        return;
      }
      this.#paint(theme === 'dark');
    }

    /** 套亮暗，再照新的那一組 token 重驗宿主頁的覆寫（同一個主色可能亮色過、暗色不過）。 */
    #paint(dark: boolean) {
      const root = this.#root;
      root.classList.toggle('dark', dark);
      root.style.colorScheme = dark ? 'dark' : 'light';
      for (const target of this.#overrides) root.style.removeProperty(target);
      const host = getComputedStyle(this);
      const own = getComputedStyle(root);
      const accepted = themeOverrides(
        {
          host: (property) => host.getPropertyValue(property),
          root: (property) => own.getPropertyValue(property),
        },
        dark ? 'dark' : 'light',
      );
      for (const [target, value] of accepted) root.style.setProperty(target, value);
      this.#overrides = accepted.map(([target]) => target);
    }
  }

  customElements.define(ELEMENT_NAME, ChatElement);
}
