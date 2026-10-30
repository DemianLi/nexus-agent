/** `App` 的畫面測試：輸入框的座位與附件：模型座、權限座、附件送出。共用的假 client 與 hook 在 `@/test/app-harness`。 */
import type {
  Event,
  ModelCatalogResult,
  ModelSelectResult,
  ModelSelection,
  PermissionCatalogResult,
  SlashRunOutcome,
  UplinkResult,
  WireClient,
} from '@nexus/wire';
import { MODEL_DOES_NOT_SUPPORT_IMAGES, PROJECTION } from '@nexus/wire';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { commandsFailedText } from '@/hooks/use-conversation';
import { stubCmdkLayout } from '@/test/cmdk';
import {
  approvalFrame,
  attachmentGate,
  fakeClient,
  frame,
  setSeq,
  toastWith,
} from '@/test/app-harness';

// `serverSupportsAttachments` 的真實作回 true（#733）；這裡接到 `attachmentGate`，預設關著，測附件的測試才打開。
vi.mock('@/lib/attachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/attachments')>()),
  serverSupportsAttachments: () => attachmentGate.on,
}));

describe('模型座（#723）', () => {
  beforeEach(stubCmdkLayout);

  const CATALOG: ModelCatalogResult = {
    ok: true,
    value: {
      catalog: {
        default: { modelId: 'model-a' },
        models: [
          { id: 'model-a', name: 'Alpha' },
          {
            id: 'model-b',
            name: 'Beta',
            reasoning: {
              efforts: [
                { id: 'low', name: '低' },
                { id: 'high', name: '高' },
              ],
              defaultEffort: 'low',
            },
          },
        ],
      },
      selection: { lastUsed: null, next: null },
    },
  };

  /** 接上模型型錄的假 client；`select` 記下每一次選擇，回 `result`。 */
  function withModels(
    result: ModelSelectResult | ((selection: ModelSelection) => ModelSelectResult) = (
      selection,
    ) => ({
      ok: true,
      value: { selected: selection },
    }),
    catalog: ModelCatalogResult = CATALOG,
  ) {
    setSeq(0);
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const selected: ModelSelection[] = [];
    const client: WireClient = {
      ...fake.client,
      modelCatalog: async () => ({ kind: 'ok', result: catalog }),
      selectModel: async (_threadId, selection) => {
        selected.push(selection);
        return { kind: 'ok', result: typeof result === 'function' ? result(selection) : result };
      },
    };
    return { ...fake, client, selected };
  }

  const seat = () => screen.queryByTestId('model-seat');
  /** SG 的 `ComposerPick`（#1591）：模型、推理強度各一個，外面包一層帶 testid 的 span。 */
  const modelTrigger = async () =>
    within(await screen.findByTestId('model-seat')).getByRole('button');
  const effortTrigger = async () =>
    within(await screen.findByTestId('effort-seat')).getByRole('button');
  const modelName = () =>
    within(screen.getByTestId('model-seat')).getByRole('button').getAttribute('aria-label');
  const effortName = () =>
    within(screen.getByTestId('effort-seat')).getByRole('button').getAttribute('aria-label');
  const pickMenu = async (name: string) => {
    const menu = await screen.findByRole('menu');
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitemradio', { name }));
    });
  };
  const typeLine = (value: string) =>
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value } });
  const submit = () => fireEvent.keyDown(screen.getByLabelText('要說的話'), { key: 'Enter' });
  const pickOption = async (name: string) => {
    const list = await screen.findByRole('listbox');
    fireEvent.click(within(list).getByText(name));
  };

  it.each([
    ['模型', modelTrigger],
    ['推理強度', effortTrigger],
  ])(
    '%s的清單開著時底下換成核准面板：清單收起，不浮在面板上（App 把 hidden 接上，#1591）',
    async (_name, triggerOf) => {
      // 推理強度那顆只有在選的模型有推理強度時才畫：預設改成 Beta。
      const { value } = CATALOG as Extract<ModelCatalogResult, { ok: true }>;
      const fake = withModels(undefined, {
        ok: true,
        value: { ...value, catalog: { ...value.catalog, default: { modelId: 'model-b' } } },
      });
      render(<App client={fake.client} />);
      fireEvent.click(await triggerOf());
      await screen.findByRole('menu');
      fake.downlink.push(fake.opened[0]!, [
        approvalFrame([{ name: 'write_file', allowed: ['approve', 'reject'] }]),
      ]);
      await screen.findByTestId('approval-card');
      expect(screen.queryByRole('menu')).toBeNull();
      expect(seat()).toBeNull();
      expect(screen.queryByTestId('effort-seat')).toBeNull();
    },
  );

  it.each([
    ['not_supported', { kind: 'rejected', code: 'not_supported', message: '還沒實作' }],
    ['其他拒絕', { kind: 'rejected', message: '這條線收不了' }],
  ] as const)('伺服器回 %s 時沒有模型座、`/` 選單也沒有 /model', async (_case, outcome) => {
    setSeq(0);
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const modelCatalog = vi.fn(async () => outcome);
    render(<App client={{ ...fake.client, modelCatalog }} />);

    await waitFor(() => expect(modelCatalog).toHaveBeenCalled());
    await screen.findByPlaceholderText('說點什麼…');
    expect(seat()).toBeNull();
    typeLine('/');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    // 沒有 /model 時，打 /model 不被客戶端攔，照一般的路由走：命令清單上沒有 `model`，就是一句話（#1929）。
    typeLine('/model');
    submit();
    await waitFor(() => expect(fake.sent).toEqual(['/model']));
    expect(fake.slashed).toEqual([]);
  });

  it('讀型錄時拋錯也不畫模型座', async () => {
    setSeq(0);
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const modelCatalog = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    render(<App client={{ ...fake.client, modelCatalog }} />);
    await waitFor(() => expect(modelCatalog).toHaveBeenCalled());
    await screen.findByPlaceholderText('說點什麼…');
    expect(seat()).toBeNull();
  });

  it('座位寫目前的模型（無障礙名稱含目前的值），沒選過就是部署預設；沒宣告推理強度就沒有那一個', async () => {
    const { client } = withModels();
    render(<App client={client} />);

    const button = await modelTrigger();
    expect(button.getAttribute('aria-label')).toBe('模型：Alpha，從下一步生效，點開切換');
    expect(button.textContent).toBe('Alpha');
    expect(button.closest('[data-slot="composer-footer-end"]')).not.toBeNull();
    expect(screen.queryByTestId('effort-seat')).toBeNull();
  });

  it('點開選另一顆：送 { modelId }，成功後座位換成新的', async () => {
    const { client, selected } = withModels();
    render(<App client={client} />);

    fireEvent.click(await modelTrigger());
    await pickMenu('Beta');

    await waitFor(() => expect(selected).toEqual([{ modelId: 'model-b' }]));
    await waitFor(() => expect(modelName()).toBe('模型：Beta，從下一步生效，點開切換'));
    expect(effortName()).toBe('推理強度：低，從下一步生效，點開切換');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('有宣告推理強度的模型才多一個「推理強度」；沒宣告的沒有', async () => {
    const { client, selected } = withModels();
    render(<App client={client} />);

    fireEvent.click(await modelTrigger());
    expect(screen.queryByTestId('effort-seat')).toBeNull();
    await pickMenu('Beta');
    await waitFor(() => expect(selected).toHaveLength(1));

    fireEvent.click(await effortTrigger());
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('推理強度')).toBeTruthy();
    await pickMenu('高');
    await waitFor(() =>
      expect(selected).toEqual([
        { modelId: 'model-b' },
        { modelId: 'model-b', reasoningEffort: 'high' },
      ]),
    );
    await waitFor(() => expect(effortName()).toBe('推理強度：高，從下一步生效，點開切換'));
    expect(modelName()).toBe('模型：Beta，從下一步生效，點開切換');
  });

  it('選不上（model_unavailable）：說出來，座位不變', async () => {
    const { client, selected } = withModels({
      ok: false,
      error: { code: 'model_unavailable', modelId: 'model-b' },
    });
    render(<App client={client} />);

    fireEvent.click(await modelTrigger());
    await pickMenu('Beta');

    await waitFor(() => expect(selected).toHaveLength(1));
    expect(await screen.findByText(/這顆模型現在選不了/u)).toBeTruthy();
    expect(modelName()).toBe('模型：Alpha，從下一步生效，點開切換');
  });

  it('伺服器推來的投影（別的分頁選的）蓋過先前的選擇', async () => {
    const { client, downlink, opened } = withModels();
    render(<App client={client} />);
    await screen.findByTestId('model-seat');

    downlink.push(opened[0]!, [
      downlink.customFrame(PROJECTION, {
        key: 'model-selection',
        version: 1,
        view: {
          lastUsed: { modelId: 'model-a' },
          next: { modelId: 'model-b', reasoningEffort: 'high' },
        },
      }),
    ]);
    await waitFor(() => expect(modelName()).toBe('模型：Beta，從下一步生效，點開切換'));
    expect(effortName()).toBe('推理強度：高，從下一步生效，點開切換');
  });

  it('自己剛選的先頂著；投影之後再推來的以伺服器為準', async () => {
    const { client, downlink, opened, selected } = withModels();
    render(<App client={client} />);

    fireEvent.click(await modelTrigger());
    await pickMenu('Beta');
    await waitFor(() => expect(selected).toHaveLength(1));
    await waitFor(() => expect(modelName()).toContain('Beta'));

    // 別的分頁把它改回 Alpha：伺服器講的比這個分頁記得的新。
    downlink.push(opened[0]!, [
      downlink.customFrame(PROJECTION, {
        key: 'model-selection',
        version: 1,
        view: { lastUsed: { modelId: 'model-b' }, next: { modelId: 'model-a' } },
      }),
    ]);
    await waitFor(() => expect(modelName()).toBe('模型：Alpha，從下一步生效，點開切換'));
    expect(screen.queryByTestId('effort-seat')).toBeNull();
  });

  describe('/model', () => {
    it('`/` 選單列出 /model；選它打開座位並清掉那一行', async () => {
      const { client } = withModels();
      render(<App client={client} />);
      await screen.findByTestId('model-seat');

      typeLine('/mod');
      await pickOption('/model');

      // 打開的是模型那個 Pick 的清單（patch `0007` 的受控 `open`）。
      const menu = await screen.findByRole('menu');
      expect(within(menu).getByRole('menuitemradio', { name: 'Alpha' })).toBeTruthy();
      expect((await modelTrigger()).getAttribute('aria-expanded')).toBe('true');
      expect((screen.getByLabelText('要說的話') as HTMLTextAreaElement).value).toBe('');
    });

    it('`/model Beta high` 直接換，不送給模型、不進佇列', async () => {
      const { client, selected, sent, slashed } = withModels();
      render(<App client={client} />);
      await screen.findByTestId('model-seat');

      typeLine('/model Beta high');
      submit();

      await waitFor(() =>
        expect(selected).toEqual([{ modelId: 'model-b', reasoningEffort: 'high' }]),
      );
      expect((screen.getByLabelText('要說的話') as HTMLTextAreaElement).value).toBe('');
      expect(sent).toEqual([]);
      expect(slashed).toEqual([]);
    });

    it('找不到那顆：說出來，那一行留在草稿裡，不選', async () => {
      const { client, selected } = withModels();
      render(<App client={client} />);
      await screen.findByTestId('model-seat');

      typeLine('/model nope');
      submit();

      expect(await screen.findByText('型錄上找不到「nope」。')).toBeTruthy();
      expect((screen.getByLabelText('要說的話') as HTMLTextAreaElement).value).toBe('/model nope');
      expect(selected).toEqual([]);
    });

    it('一輪還在跑時也能換（從下一步生效）', async () => {
      setSeq(0);
      const running = fakeClient([
        frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      ]);
      const selected: ModelSelection[] = [];
      const client: WireClient = {
        ...running.client,
        modelCatalog: async () => ({ kind: 'ok', result: CATALOG }),
        selectModel: async (_threadId, selection) => {
          selected.push(selection);
          return { kind: 'ok', result: { ok: true, value: { selected: selection } } };
        },
      };
      render(<App client={client} />);
      await screen.findByTestId('model-seat');
      await waitFor(() => expect(screen.getByRole('status').textContent).toContain('執行中'));

      typeLine('/model beta');
      submit();

      await waitFor(() => expect(selected).toEqual([{ modelId: 'model-b' }]));
    });
  });
});

describe('權限座（#437）', () => {
  beforeEach(stubCmdkLayout);

  const CATALOG: PermissionCatalogResult = {
    ok: true,
    value: {
      catalog: {
        options: [
          { value: 'read-only', name: '唯讀', description: '只能讀，改東西要問' },
          { value: 'workspace-write', name: '可寫工作區' },
          { value: 'danger-full-access', name: '全開' },
        ],
        defaultOptions: [{ value: 'workspace-write', name: '可寫工作區' }],
        defaultPreset: 'workspace-write',
      },
    },
  };

  const seat = () => screen.queryByTestId('permission-seat');
  const permissionFrame = (
    downlink: ReturnType<typeof fakeClient>['downlink'],
    currentValue: string,
  ): Event =>
    downlink.customFrame(PROJECTION, {
      key: 'permissions',
      version: 1,
      view: { currentValue },
    });

  /** 接上權限目錄的假 client；`current` 不是 `undefined` 就在一開始推那顆投影。 */
  async function withPermissions(
    current: string | undefined,
    events: readonly Event[] = [frame('lifecycle', [], { event: 'completed', graph_name: 'root' })],
  ) {
    setSeq(0);
    const fake = fakeClient(events);
    const client: WireClient = {
      ...fake.client,
      permissionCatalog: async () => ({ kind: 'ok', result: CATALOG }),
    };
    render(<App client={client} />);
    await screen.findByPlaceholderText('說點什麼…');
    if (current !== undefined) {
      fake.downlink.push(fake.opened[0]!, [permissionFrame(fake.downlink, current)]);
      await screen.findByTestId('permission-seat');
    }
    return fake;
  }

  /** SG 的 `ComposerPick`（#1591）：外面那層帶 testid 與 `data-danger`，裡面是 Trigger。 */
  const trigger = () => within(screen.getByTestId('permission-seat')).getByRole('button');
  const triggerName = () => trigger().getAttribute('aria-label');
  /** 選項的名稱後面接著它的說明（`hint`），所以比開頭。 */
  const option = (menu: HTMLElement, name: string) =>
    within(menu).getByRole('menuitemradio', { name: new RegExp(`^${name}`) });
  const pickOption = async (name: string) => {
    fireEvent.click(within(await screen.findByTestId('permission-seat')).getByRole('button'));
    const menu = await screen.findByRole('menu');
    await act(async () => {
      fireEvent.click(option(menu, name));
    });
  };

  it('清單開著時底下換成核准面板：清單收起、這顆不畫（App 把 hidden 接上，#1591）', async () => {
    // 三顆一起先備好、seq 照順序：投影若走 `downlink.customFrame`，seq 從很大的數起算，之後推的核准 frame 會被當成舊的丟掉。
    setSeq(0);
    const events = [
      frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
      frame('custom', [], {
        name: PROJECTION,
        payload: { key: 'permissions', version: 1, view: { currentValue: 'workspace-write' } },
      }),
    ];
    const approval = approvalFrame([{ name: 'write_file', allowed: ['approve', 'reject'] }]);
    const fake = await withPermissions(undefined, events);
    fireEvent.click(
      await within(await screen.findByTestId('permission-seat')).findByRole('button'),
    );
    await screen.findByRole('menu');
    fake.downlink.push(fake.opened[0]!, [approval]);
    await screen.findByTestId('approval-card');
    expect(screen.queryByRole('menu')).toBeNull();
    // 清單的收起其實由鎖住那條先做了（有待決就是 `awaiting-input`，同一次畫）；`hidden` 管的是這顆不畫。
    expect(seat()).toBeNull();
  });

  it.each([
    ['not_supported', { kind: 'rejected', code: 'not_supported', message: '還沒實作' }],
    ['其他拒絕', { kind: 'rejected', message: '這條線收不了' }],
  ] as const)('目錄回 %s：沒有權限座，即使投影到了', async (_case, outcome) => {
    setSeq(0);
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const permissionCatalog = vi.fn(async () => outcome);
    render(<App client={{ ...fake.client, permissionCatalog }} />);
    await screen.findByPlaceholderText('說點什麼…');
    await waitFor(() => expect(permissionCatalog).toHaveBeenCalled());
    fake.downlink.push(fake.opened[0]!, [permissionFrame(fake.downlink, 'workspace-write')]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seat()).toBeNull();
  });

  it('投影沒有送來（這個組裝沒有權限組合）：沒有權限座', async () => {
    await withPermissions(undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seat()).toBeNull();
  });

  it('座位寫目前的組（無障礙名稱含目前的值），投影換了就跟著換', async () => {
    const fake = await withPermissions('workspace-write');
    expect(triggerName()).toBe('權限：可寫工作區，點開切換');
    expect(trigger().textContent).toBe('可寫工作區');
    expect(screen.getByTestId('permission-seat').getAttribute('data-danger')).toBe('false');
    // 底列左邊（SG demo 的「模式」），不在右邊那一組裡。
    expect(trigger().closest('[data-slot="composer-footer"]')).not.toBeNull();
    expect(trigger().closest('[data-slot="composer-footer-end"]')).toBeNull();

    fake.downlink.push(fake.opened[0]!, [permissionFrame(fake.downlink, 'read-only')]);
    await waitFor(() => expect(triggerName()).toBe('權限：唯讀，點開切換'));
  });

  it('`custom`（對不上任何一組）寫「自訂」，清單裡沒有哪一列打勾', async () => {
    await withPermissions('custom');
    expect(triggerName()).toBe('權限：自訂，點開切換');
    expect(trigger().textContent).toBe('自訂');
    fireEvent.click(trigger());
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items).toHaveLength(3);
    expect(items.filter((item) => item.getAttribute('aria-checked') === 'true')).toEqual([]);
    // 選項底下寫 preset 的說明（SG 的 `hint`）。
    expect(option(menu, '唯讀').textContent).toContain('只能讀，改東西要問');
  });

  it('選另一組：送 `/permission <組名>`；座位等伺服器推新值才換', async () => {
    const { slashed } = await withPermissions('workspace-write');

    await pickOption('唯讀');

    await waitFor(() => expect(slashed).toEqual(['/permission read-only']));
    expect(triggerName()).toBe('權限：可寫工作區，點開切換');
  });

  it('選目前這一組：什麼都不送', async () => {
    const { slashed } = await withPermissions('workspace-write');
    await pickOption('可寫工作區');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(slashed).toEqual([]);
  });

  it('命令失敗：原因由斜線命令的那一套顯示，座位不自己改', async () => {
    setSeq(0);
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const client: WireClient = {
      ...fake.client,
      permissionCatalog: async () => ({ kind: 'ok', result: CATALOG }),
      slashRun: async () => ({ kind: 'error', text: '這一組在設定裡被拿掉了' }),
    };
    render(<App client={client} />);
    await screen.findByPlaceholderText('說點什麼…');
    fake.downlink.push(fake.opened[0]!, [permissionFrame(fake.downlink, 'workspace-write')]);
    await pickOption('唯讀');

    expect(await screen.findByText('這一組在設定裡被拿掉了')).toBeTruthy();
    expect(triggerName()).toContain('可寫工作區');
  });

  describe('全開要先確認', () => {
    it('選「全開」先跳確認，還沒送；取消就不送', async () => {
      const { slashed } = await withPermissions('workspace-write');

      await pickOption('全開');

      const dialog = await screen.findByRole('alertdialog');
      expect(within(dialog).getByText('切換到「全開」？')).toBeTruthy();
      expect(within(dialog).getByText(/不再跳出核准請求/u)).toBeTruthy();
      expect(slashed).toEqual([]);
      // 預設落在取消：不小心按 Enter 不會切過去。Base UI 在打開後才搬焦點（第一個可 tab 的，就是取消）。
      await waitFor(() => expect(document.activeElement?.textContent).toBe('取消'));

      fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(slashed).toEqual([]);
    });

    it('按「切換」才送 `/permission danger-full-access`', async () => {
      const { slashed } = await withPermissions('workspace-write');

      await pickOption('全開');
      const dialog = await screen.findByRole('alertdialog');
      fireEvent.click(within(dialog).getByRole('button', { name: '切換' }));

      await waitFor(() => expect(slashed).toEqual(['/permission danger-full-access']));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    });

    it('其他組不問、直接送；目前就是全開時座位換警示色', async () => {
      const fake = await withPermissions('danger-full-access');
      // 顏色本身由覆寫檔對 `data-danger` 上色（README 本地修改第 35 條），guard 量。
      expect(screen.getByTestId('permission-seat').getAttribute('data-danger')).toBe('true');

      await pickOption('唯讀');

      await waitFor(() => expect(fake.slashed).toEqual(['/permission read-only']));
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });

  // 照 dsh `PermissionSelect.tsx:180`（#1591 PM 決定第 2 題）：鎖住時清單打不開，不是打開了每列停用。Trigger 照樣聚焦得到，
  // 原因只在報讀名稱裡（看畫面的人只看得到它停用了；dsh 也只放在 `title`）。
  it('一輪在跑時清單打不開，原因寫在名稱裡，Trigger 仍聚焦得到', async () => {
    const { slashed } = await withPermissions('workspace-write', [
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
    ]);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('執行中'));

    await waitFor(() => expect(triggerName()).toBe('權限：可寫工作區，這一輪結束後才能切換'));
    expect(trigger().getAttribute('aria-disabled')).toBe('true');
    expect(trigger().hasAttribute('disabled')).toBe(false);
    fireEvent.click(trigger());
    fireEvent.keyDown(trigger(), { key: 'Enter' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(slashed).toEqual([]);
  });
});

describe('附件送出（#733、#732）', () => {
  beforeEach(() => {
    attachmentGate.on = true;
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
  });

  const png = (name = 'shot.png') => new File(['PNG'], name, { type: 'image/png' });
  const pdf = (name = 'plan.pdf') => new File(['PDF'], name, { type: 'application/pdf' });

  /** 接好上傳與送出的假 client：`runStart` 記下每次的參數，`uploadFile` 回 `r-<檔名>`。 */
  function withUploads(
    runStartResult: UplinkResult = { type: 'success', id: 1, result: { run_id: 'run-1' } },
  ) {
    setSeq(0);
    const fake = fakeClient([frame('lifecycle', [], { event: 'completed', graph_name: 'root' })]);
    const uploads: { threadId: string; name: string | undefined }[] = [];
    const runStart = vi.fn(async (..._args: Parameters<WireClient['runStart']>) => runStartResult);
    const client: WireClient = {
      ...fake.client,
      runStart,
      uploadFile: async (threadId, _body, name) => {
        uploads.push({ threadId, name });
        return { kind: 'ok', receipt: { receiptId: `r-${name}`, name: name ?? '', bytes: 3 } };
      },
    };
    return { ...fake, client, runStart, uploads };
  }

  const addFiles = (files: File[]) =>
    fireEvent.change(screen.getByTestId('attachment-input'), { target: { files } });
  const input = () => screen.getByLabelText('要說的話') as HTMLTextAreaElement;
  const chips = () => screen.queryAllByTestId('draft-attachment');
  const send = (text: string) => {
    fireEvent.change(input(), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
  };

  it('圖內嵌、檔案先上傳換收據，照選取順序帶進 run.start；收下後草稿與附件都清掉', async () => {
    const { client, runStart, uploads } = withUploads();
    render(<App client={client} />);
    await screen.findByPlaceholderText('說點什麼…');

    addFiles([png('a.png'), pdf('b.pdf'), png('c.png')]);
    expect(chips()).toHaveLength(3);
    send('看這幾個');

    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    const [threadId, text, options] = runStart.mock.calls[0]!;
    expect(text).toBe('看這幾個');
    expect(options?.attachments).toEqual([
      { type: 'image', mediaType: 'image/png', data: btoa('PNG'), name: 'a.png' },
      { type: 'file', receiptId: 'r-b.pdf' },
      { type: 'image', mediaType: 'image/png', data: btoa('PNG'), name: 'c.png' },
    ]);
    // 只有檔案上傳，傳到的是同一條 thread。
    expect(uploads).toEqual([{ threadId, name: 'b.pdf' }]);
    await waitFor(() => expect(chips()).toHaveLength(0));
    expect(input().value).toBe('');
  });

  it('只有附件、沒打字也送得出去：文字是空字串，附件照帶；沒附件沒文字仍送不出', async () => {
    const { client, runStart } = withUploads();
    render(<App client={client} />);
    await screen.findByPlaceholderText('說點什麼…');
    const sendButton = () => screen.getByRole('button', { name: '送出' });

    expect(sendButton().hasAttribute('disabled')).toBe(true);
    addFiles([png('a.png'), pdf('b.pdf')]);
    expect(input().value).toBe('');
    await waitFor(() => expect(sendButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(sendButton());

    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    const [, text, options] = runStart.mock.calls[0]!;
    expect(text).toBe('');
    expect(options?.attachments).toEqual([
      { type: 'image', mediaType: 'image/png', data: btoa('PNG'), name: 'a.png' },
      { type: 'file', receiptId: 'r-b.pdf' },
    ]);
    await waitFor(() => expect(chips()).toHaveLength(0));
    expect(sendButton().hasAttribute('disabled')).toBe(true);
  });

  it('只有附件時 Enter 也送；Cmd+Enter 是帶著附件插話，不是把佇列改成插話', async () => {
    const { client, runStart } = withUploads();
    render(<App client={client} />);
    await screen.findByPlaceholderText('說點什麼…');

    addFiles([png('a.png')]);
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(runStart.mock.calls[0]![1]).toBe('');

    addFiles([png('b.png')]);
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true, ctrlKey: true });
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(2));
    expect(runStart.mock.calls[1]![2]?.attachments).toHaveLength(1);
  });

  it('被拒時只有附件的那句：附件留著，草稿維持空白', async () => {
    const { client, runStart } = withUploads({
      type: 'error',
      id: 1,
      error: 'invalid_argument',
      message: '只有附件的那句被拒了（伺服器的話）',
    });
    render(<App client={client} />);
    await screen.findByPlaceholderText('說點什麼…');
    addFiles([png('a.png')]);
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/只有附件的那句被拒了/u)).toBeTruthy();
    expect(chips()).toHaveLength(1);
    expect(input().value).toBe('');
  });

  it('沒有附件：run.start 沒有 attachments 這個鍵（只多了請求編號與時區，#1335、#1630）', async () => {
    const { client, runStart, uploads } = withUploads();
    render(<App client={client} />);
    await screen.findByPlaceholderText('說點什麼…');
    send('只有字');
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(Object.keys(runStart.mock.calls[0]![2] as object)).toEqual([
      'requestId',
      'clientTimeZone',
    ]);
    expect(uploads).toEqual([]);
  });

  it.each([
    [
      '目前的模型不收圖',
      { type: 'error', id: 1, error: MODEL_DOES_NOT_SUPPORT_IMAGES, message: 'model rejects' },
      '目前的模型不收圖片',
    ],
    [
      '伺服器不收附件',
      { type: 'error', id: 1, error: 'not_supported', message: 'no attachment store' },
      '這個伺服器不收附件。',
    ],
    [
      '別的原因',
      { type: 'error', id: 1, error: 'invalid_argument', message: '圖太大了（伺服器的話）' },
      '圖太大了（伺服器的話）',
    ],
  ] as const)('被拒（%s）：說原因，草稿與附件都留著', async (_case, result, shown) => {
    const { client, runStart } = withUploads(result as UplinkResult);
    render(<App client={client} />);
    await screen.findByPlaceholderText('說點什麼…');

    addFiles([png('a.png'), pdf('b.pdf')]);
    send('這句會被拒');

    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(new RegExp(shown, 'u'))).toBeTruthy();
    await waitFor(() => expect(input().value).toBe('這句會被拒'));
    expect(chips()).toHaveLength(2);
  });

  it('沒送出去後原樣重送沿用編號（收據會重新上傳，比的是草稿附件）；增減附件是新的一句（#1335）', async () => {
    const { client, runStart, uploads } = withUploads({
      type: 'error',
      id: 1,
      error: 'invalid_argument',
      message: '帶附件的這句沒收下（#1335）',
    });
    render(<App client={client} />);
    await screen.findByPlaceholderText('說點什麼…');
    const ids = () => runStart.mock.calls.map(([, , options]) => options?.requestId);

    addFiles([png('a.png'), pdf('b.pdf')]);
    send('帶附件');
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(input().value).toBe('帶附件'));

    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(2));
    expect(uploads.map((upload) => upload.name)).toEqual(['b.pdf', 'b.pdf']);
    expect(ids()[1]).toBe(ids()[0]);

    await waitFor(() => expect(input().value).toBe('帶附件'));
    addFiles([pdf('c.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(3));
    expect(ids()[2]).not.toBe(ids()[1]);

    await waitFor(() => expect(input().value).toBe('帶附件'));
    fireEvent.click(screen.getAllByRole('button', { name: /移除/u })[0]!);
    await waitFor(() => expect(chips()).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(4));
    expect(ids()[3]).not.toBe(ids()[2]);
    expect(ids()[3]).not.toBe(ids()[0]);
  });

  it('上傳失敗：這句不送，說原因，草稿與附件留著；再按一次會重傳', async () => {
    const { client, runStart, uploads } = withUploads();
    let failing = true;
    const failingClient: WireClient = {
      ...client,
      uploadFile: async (threadId, body, name, signal) => {
        if (failing) return { kind: 'rejected', message: '磁碟滿了' };
        return client.uploadFile(threadId, body, name, signal);
      },
    };
    render(<App client={failingClient} />);
    await screen.findByPlaceholderText('說點什麼…');

    addFiles([pdf('b.pdf')]);
    send('帶檔案');
    expect(await screen.findByText('「b.pdf」上傳失敗：磁碟滿了')).toBeTruthy();
    expect(runStart).not.toHaveBeenCalled();
    await waitFor(() => expect(input().value).toBe('帶檔案'));
    expect(chips()).toHaveLength(1);

    failing = false;
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(uploads).toEqual([{ threadId: expect.any(String), name: 'b.pdf' }]);
  });

  it('附件送出期間移除鈕不收、加入照收：送出的是按送出當下那一批（#1941）', async () => {
    const { client, runStart } = withUploads();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: WireClient = {
      ...client,
      uploadFile: async (threadId, body, name, signal) => {
        await gate;
        return client.uploadFile(threadId, body, name, signal);
      },
    };
    render(<App client={slow} />);
    await screen.findByPlaceholderText('說點什麼…');

    addFiles([pdf('a.pdf'), png('b.png')]);
    send('帶這兩個（#1941）');
    // a.pdf 在上傳（那一格換成取消上傳），b.png 是內嵌圖、移除鈕還在。
    await screen.findByRole('button', { name: '取消上傳 a.pdf' });
    fireEvent.click(screen.getByRole('button', { name: '移除 b.png' }));
    expect(chips()).toHaveLength(2);
    // 送出期間才加進來的照收，送出之後留著。
    addFiles([png('c.png')]);
    expect(chips()).toHaveLength(3);

    release();
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(runStart.mock.calls[0]![2]?.attachments).toEqual([
      { type: 'file', receiptId: 'r-a.pdf' },
      { type: 'image', mediaType: 'image/png', data: btoa('PNG'), name: 'b.png' },
    ]);
    await waitFor(() => expect(chips()).toHaveLength(1));
    // 送完放開：留下來的那一張移除得掉。
    fireEvent.click(screen.getByRole('button', { name: '移除 c.png' }));
    expect(chips()).toHaveLength(0);
  });

  it('送出中不收第二次送出', async () => {
    const { client, runStart } = withUploads();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: WireClient = {
      ...client,
      uploadFile: async (threadId, body, name, signal) => {
        await gate;
        return client.uploadFile(threadId, body, name, signal);
      },
    };
    render(<App client={slow} />);
    await screen.findByPlaceholderText('說點什麼…');

    addFiles([pdf('b.pdf')]);
    send('第一句');
    fireEvent.change(input(), { target: { value: '第二句' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '送出' }).hasAttribute('disabled')).toBe(true),
    );
    release();
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(runStart.mock.calls[0]![1]).toBe('第一句');
  });

  it('送出期間才加進來的附件，收下後留著；只清掉送出的那一批', async () => {
    const { client, runStart } = withUploads();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: WireClient = {
      ...client,
      uploadFile: async (threadId, body, name, signal) => {
        await gate;
        return client.uploadFile(threadId, body, name, signal);
      },
    };
    render(<App client={slow} />);
    await screen.findByPlaceholderText('說點什麼…');

    addFiles([pdf('first.pdf')]);
    send('第一句');
    addFiles([pdf('late.pdf')]);
    release();

    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(chips()[0]!.textContent).toContain('late.pdf');
  });

  describe('上傳進度與取消（#733）', () => {
    type Progress = (progress: { loaded: number; total?: number }) => void;

    /** 上傳會一直掛著、自己報進度，收到 abort 才結束的假 client；`finish` 讓目前掛著的那次成功。 */
    function hanging() {
      const base = withUploads();
      const report: Progress[] = [];
      const finishers: (() => void)[] = [];
      let starts = 0;
      const client: WireClient = {
        ...base.client,
        uploadFile: ((
          threadId: string,
          body: Blob | Uint8Array,
          name?: string,
          signal?: AbortSignal,
          onProgress?: Progress,
        ) => {
          starts += 1;
          if (onProgress !== undefined) report.push(onProgress);
          return new Promise((resolve, reject) => {
            signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
            finishers.push(() => resolve(base.client.uploadFile(threadId, body, name, signal)));
          });
        }) as WireClient['uploadFile'],
      };
      return {
        ...base,
        client,
        report: (progress: { loaded: number; total?: number }) =>
          act(() => report.at(-1)?.(progress)),
        finish: () => act(async () => finishers.at(-1)?.()),
        starts: () => starts,
      };
    }

    const bar = () => screen.getByRole('progressbar', { name: '上傳 b.pdf' });

    it('上傳中卡片畫進度條，跟著進度回呼走；傳完後收下，卡片離開草稿', async () => {
      const { client, runStart, report, finish } = hanging();
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');

      addFiles([pdf('b.pdf')]);
      // 沒送出之前沒有進度條：附件還沒開始上傳。
      expect(screen.queryByRole('progressbar')).toBeNull();
      send('帶檔案');
      await waitFor(() => expect(bar()).toBeTruthy());
      expect(bar().hasAttribute('aria-valuenow')).toBe(false);

      report({ loaded: 30, total: 100 });
      expect(bar().getAttribute('aria-valuenow')).toBe('30');
      report({ loaded: 80, total: 100 });
      expect(bar().getAttribute('aria-valuenow')).toBe('80');
      expect(screen.queryByRole('button', { name: '移除 b.pdf' })).toBeNull();

      await finish();
      await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(chips()).toHaveLength(0));
      expect(screen.queryByRole('progressbar')).toBeNull();
    });

    it('取消：卡片回到未上傳，這一句不送，草稿與附件都在；不當成錯誤', async () => {
      const { client, runStart } = hanging();
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');

      addFiles([pdf('b.pdf')]);
      send('帶檔案');
      fireEvent.click(await screen.findByRole('button', { name: '取消上傳 b.pdf' }));

      await waitFor(() => expect(chips()[0]!.textContent).toContain('未上傳（已取消）'));
      expect(screen.queryByRole('progressbar')).toBeNull();
      // sonner 的 toast 是全域的、跨測試留著：斷言這一條才有的說明，不斷言共用的標題；
      // 不是錯誤，看的是那一條 toast 自己的種類（`toast.error` 會帶 `data-type="error"`）。
      const note = (await screen.findAllByText('附件還在，再按送出會重新上傳。'))[0]!;
      expect(note.closest('[data-sonner-toast]')?.getAttribute('data-type')).not.toBe('error');
      expect(runStart).not.toHaveBeenCalled();
      await waitFor(() => expect(input().value).toBe('帶檔案'));
      expect(chips()).toHaveLength(1);
      expect(screen.getByRole('button', { name: '移除 b.pdf' })).toBeTruthy();
    });

    it('取消後重試：再按送出重新上傳，這一次傳完就送出；進度從頭算', async () => {
      const { client, runStart, report, finish, starts } = hanging();
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');

      addFiles([pdf('b.pdf')]);
      send('帶檔案');
      report({ loaded: 90, total: 100 });
      fireEvent.click(await screen.findByRole('button', { name: '取消上傳 b.pdf' }));
      await waitFor(() => expect(chips()[0]!.textContent).toContain('未上傳（已取消）'));
      await waitFor(() => expect(input().value).toBe('帶檔案'));

      await waitFor(() =>
        expect(screen.getByRole('button', { name: '送出' }).hasAttribute('disabled')).toBe(false),
      );
      fireEvent.click(screen.getByRole('button', { name: '送出' }));
      await waitFor(() => expect(starts()).toBe(2));
      await waitFor(() => expect(bar()).toBeTruthy());
      expect(bar().hasAttribute('aria-valuenow')).toBe(false);
      expect(chips()[0]!.textContent).not.toContain('未上傳');

      await finish();
      await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
      expect(runStart.mock.calls[0]![2]?.attachments).toEqual([
        { type: 'file', receiptId: 'r-b.pdf' },
      ]);
      await waitFor(() => expect(chips()).toHaveLength(0));
    });

    it('取消是整句取消：同一句裡的另一個檔案也回到未上傳', async () => {
      const { client, runStart } = hanging();
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');

      addFiles([pdf('b.pdf'), pdf('c.pdf')]);
      send('兩個檔案');
      await waitFor(() => expect(screen.getAllByRole('progressbar')).toHaveLength(2));
      fireEvent.click(screen.getByRole('button', { name: '取消上傳 c.pdf' }));

      await waitFor(() =>
        expect(chips().map((chip) => chip.getAttribute('data-upload'))).toEqual(['idle', 'idle']),
      );
      expect(runStart).not.toHaveBeenCalled();
    });

    it('上傳失敗的卡寫「未上傳（上傳失敗）」；再送時又變回上傳中', async () => {
      const { client, runStart } = withUploads();
      let failing = true;
      const flaky: WireClient = {
        ...client,
        uploadFile: async (threadId, body, name, signal) =>
          failing
            ? { kind: 'rejected', message: '磁碟滿了' }
            : client.uploadFile(threadId, body, name, signal),
      };
      render(<App client={flaky} />);
      await screen.findByPlaceholderText('說點什麼…');
      addFiles([pdf('b.pdf')]);
      send('帶檔案');
      await waitFor(() => expect(chips()[0]!.textContent).toContain('未上傳（上傳失敗）'));
      expect(chips()[0]!.getAttribute('data-state')).toBe('error');

      failing = false;
      await waitFor(() => expect(input().value).toBe('帶檔案'));
      fireEvent.click(screen.getByRole('button', { name: '送出' }));
      await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    });

    it('上傳成功、伺服器沒收下這一句：卡片照常畫（不寫上傳失敗），附件還在', async () => {
      const { client, runStart } = withUploads({
        type: 'error',
        id: 1,
        error: 'invalid_argument',
        message: '這句被拒了（伺服器的話）',
      });
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');
      addFiles([pdf('b.pdf')]);
      send('帶檔案');
      await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
      expect(await screen.findByText(/這句被拒了/u)).toBeTruthy();
      expect(chips()).toHaveLength(1);
      expect(chips()[0]!.getAttribute('data-upload')).toBe('none');
      expect(chips()[0]!.textContent).toContain('PDF');
      expect(screen.getByRole('button', { name: '移除 b.pdf' })).toBeTruthy();
    });
  });

  describe('斜線命令帶附件（#733）', () => {
    // 命令列在清單上，打 `/` 會開選單（#1929）。
    beforeEach(stubCmdkLayout);
    type SlashCall = { line: string; attachments: Parameters<WireClient['slashRun']>[2] };
    function withSlash(run: (line: string) => SlashRunOutcome) {
      const fake = withUploads();
      const calls: SlashCall[] = [];
      const client: WireClient = {
        ...fake.client,
        // 開頭的字在命令清單上才走 `slash.run`（#1929）：這一組送的命令都列上。
        slashList: async () => ({
          kind: 'ok',
          // 都宣告 `input`，跟出貨的命令一樣（#1971：沒宣告的帶了字就是一句話）。
          commands: ['goal', 'other', 'nope', 'plan', 'feedback'].map((name) => ({
            name,
            description: name,
            input: { hint: '<參數>' },
          })),
        }),
        slashRun: async (_threadId, line, attachments) => {
          calls.push({ line, attachments });
          return run(line);
        },
      };
      return { ...fake, client, calls };
    }

    it('命令收下：附件（檔案先換成收據）放進 slash.run，不走 run.start；草稿與附件都清掉', async () => {
      const { client, calls, runStart, uploads } = withSlash(() => ({
        kind: 'success',
        command_id: 'c',
      }));
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');

      addFiles([pdf('note.pdf'), png('a.png')]);
      send('/goal 照附件做');

      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toEqual({
        line: '/goal 照附件做',
        attachments: [
          { type: 'file', receiptId: 'r-note.pdf' },
          { type: 'image', mediaType: 'image/png', data: btoa('PNG'), name: 'a.png' },
        ],
      });
      expect(uploads).toHaveLength(1);
      expect(runStart).not.toHaveBeenCalled();
      await waitFor(() => expect(chips()).toHaveLength(0));
      expect(input().value).toBe('');
    });

    it('命令清單抓失敗：這一行沒送出去，草稿文字與附件卡都還在、沒有上傳（#1929）', async () => {
      const { client, calls, uploads, runStart } = withSlash(() => ({
        kind: 'success',
        command_id: 'c',
      }));
      const slashList: WireClient['slashList'] = async () => ({
        kind: 'rejected',
        message: '清單讀不出來（#1929 附件）',
      });
      render(<App client={{ ...client, slashList }} />);
      await screen.findByPlaceholderText('說點什麼…');

      addFiles([pdf('c.pdf')]);
      send('/goal 照附件做');

      const card = await toastWith(commandsFailedText('清單讀不出來（#1929 附件）'));
      expect(card.textContent).toContain('這一句沒送出去');
      expect(calls).toHaveLength(0);
      expect(runStart).not.toHaveBeenCalled();
      expect(uploads).toHaveLength(0);
      expect(input().value).toBe('/goal 照附件做');
      expect(chips()).toHaveLength(1);
      expect(screen.getByRole('button', { name: '移除 c.pdf' })).toBeTruthy();
    });

    /** 命令清單到不了、直到測試叫它到（#1929）：開頁那一次就卡在途。 */
    function heldList() {
      let arrive: (() => void) | undefined;
      const slashList: WireClient['slashList'] = () =>
        new Promise((resolve) => {
          arrive = () =>
            resolve({
              kind: 'ok',
              commands: [{ name: 'goal', description: 'goal', input: { hint: '<參數>' } }],
            });
        });
      return { slashList, arrive: () => arrive!() };
    }

    it('等清單認的期間：移除、加入、拖放附件都不動作；放行後送出的附件就是畫面上那些（#1929，dsh facade 拒收）', async () => {
      const { client, calls, uploads } = withSlash(() => ({ kind: 'success', command_id: 'c' }));
      const held = heldList();
      render(<App client={{ ...client, slashList: held.slashList }} />);
      await screen.findByPlaceholderText('說點什麼…');

      addFiles([pdf('a.pdf'), png('b.png')]);
      send('/goal 照附件做');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(calls).toHaveLength(0);

      fireEvent.click(screen.getByRole('button', { name: '移除 a.pdf' }));
      addFiles([png('c.png')]);
      fireEvent.dragEnter(window, { dataTransfer: { types: ['Files'] } });
      expect(screen.queryByTestId('drop-overlay')).toBeNull();
      // 照樣接住（不讓瀏覽器把檔案開成新頁），只是不收。
      expect(
        fireEvent.drop(window, { dataTransfer: { types: ['Files'], files: [png('d.png')] } }),
      ).toBe(false);
      // 貼上檔案也一樣：接住（不貼成文字），不收。
      expect(
        fireEvent.paste(input(), {
          clipboardData: { files: [png('e.png')], types: ['Files'], getData: () => '' },
        }),
      ).toBe(false);
      expect(screen.getByRole('button', { name: '加入附件' }).hasAttribute('disabled')).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(chips()).toHaveLength(2);

      held.arrive();
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toEqual({
        line: '/goal 照附件做',
        attachments: [
          { type: 'file', receiptId: 'r-a.pdf' },
          { type: 'image', mediaType: 'image/png', data: btoa('PNG'), name: 'b.png' },
        ],
      });
      expect(uploads.map((upload) => upload.name)).toEqual(['a.pdf']);
      await waitFor(() => expect(chips()).toHaveLength(0));
      expect(screen.getByRole('button', { name: '加入附件' }).hasAttribute('disabled')).toBe(false);
    });

    it('帶附件等清單時換到新對話：不上傳、不送；清單後來到也一樣（dsh 的 release）', async () => {
      const { client, calls, uploads, runStart } = withSlash(() => ({
        kind: 'success',
        command_id: 'c',
      }));
      const held = heldList();
      render(<App client={{ ...client, slashList: held.slashList }} />);
      await screen.findByPlaceholderText('說點什麼…');
      // 這條講過話，「新對話」才會真的換一條（空白的留在原地，#313）。
      send('先講一句');
      await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));

      addFiles([pdf('a.pdf')]);
      send('/goal 照附件做');
      await new Promise((resolve) => setTimeout(resolve, 30));
      fireEvent.click(screen.getByRole('button', { name: '新對話' }));
      await waitFor(() => expect(input().value).toBe(''));
      expect(chips()).toHaveLength(0);

      held.arrive();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(uploads).toHaveLength(0);
      expect(calls).toHaveLength(0);
      expect(runStart).toHaveBeenCalledTimes(1);
      // 靜默：不跳中止的原因（toast 跨測試留著，所以只認這一句；沒給 reason 時是瀏覽器的 AbortError）。
      expect(screen.queryByText(/aborted|不等命令清單了/u)).toBeNull();
    });

    it('帶附件的命令斷在網路層：照舊說沒送出去，不說原樣重送不會重複（命令沒有請求編號，#1335）', async () => {
      const { client, calls } = withSlash(() => {
        throw new TypeError('命令斷了（#1335 toast）');
      });
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');

      addFiles([pdf('b.pdf')]);
      send('/goal 斷線');

      const card = await toastWith('命令斷了（#1335 toast）');
      expect(card.getAttribute('data-type')).toBe('error');
      expect(card.textContent).toContain('這一句沒送出去');
      expect(card.textContent).not.toContain('不會重複');
      expect(calls).toHaveLength(1);
      await waitFor(() => expect(input().value).toBe('/goal 斷線'));
    });

    it('命令回錯誤（不收附件）：錯誤畫出來，草稿文字與附件卡都還在', async () => {
      const { client, calls } = withSlash(() => ({
        kind: 'error',
        text: 'Command "/model" does not accept attachments.',
      }));
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');

      addFiles([pdf('b.pdf')]);
      send('/other 試試');

      expect(await screen.findAllByText(/does not accept attachments/u)).not.toHaveLength(0);
      expect(calls).toHaveLength(1);
      await waitFor(() => expect(input().value).toBe('/other 試試'));
      expect(chips()).toHaveLength(1);
    });

    it('不認得的命令：同樣說出來、草稿與附件留著', async () => {
      const { client } = withSlash(() => ({ kind: 'unknown' }));
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');

      addFiles([pdf('b.pdf')]);
      send('/nope');

      expect(await screen.findAllByText(/不認得這個命令：\/nope/u)).not.toHaveLength(0);
      await waitFor(() => expect(input().value).toBe('/nope'));
      expect(chips()).toHaveLength(1);
    });

    it('沒帶附件的命令：照舊，slash.run 不帶附件', async () => {
      const { client, calls } = withSlash(() => ({ kind: 'success', command_id: 'c' }));
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');

      send('/plan');

      await waitFor(() => expect(calls).toEqual([{ line: '/plan', attachments: undefined }]));
    });

    it('光打 /feedback 只開回饋框：不上傳、不送出，附件留在草稿裡', async () => {
      const { client, calls, uploads } = withSlash(() => ({ kind: 'success', command_id: 'c' }));
      render(<App client={client} />);
      await screen.findByPlaceholderText('說點什麼…');

      addFiles([pdf('b.pdf')]);
      send('/feedback');

      await screen.findByRole('dialog');
      expect(calls).toEqual([]);
      expect(uploads).toEqual([]);
      expect(chips()).toHaveLength(1);
    });
  });

  it('超過上限的圖不收進草稿，並說原因', async () => {
    const { client } = withUploads();
    render(<App client={client} />);
    await screen.findByPlaceholderText('說點什麼…');

    const big = png('big.png');
    Object.defineProperty(big, 'size', { value: 25 * 1024 * 1024 });
    addFiles([big, pdf('ok.pdf')]);

    expect(await screen.findByText(/「big.png」有 25.0 MB/u)).toBeTruthy();
    expect(chips().map((chip) => chip.textContent)).toEqual([expect.stringContaining('ok.pdf')]);
  });
});
