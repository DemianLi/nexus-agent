/**
 * #1386 驗收 ①：只相依 vendor 的 `@nexus/cordis` 與 `@nexus/cordis-plugin-loader`，在 `module: NodeNext` 下型別解得到。
 *
 * 每一行 `@ts-expect-error` 是一道牙：型別若退化成 `any`，那一行就不再報錯，標記變成未使用，tsc 會紅。
 * 「解得到」靠這幾行證明，不是靠 tsc 綠。
 */
import { Context, Service } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';

declare module '@nexus/cordis' {
  interface Context {
    greeter: Greeter;
  }
}

class Greeter extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter');
  }

  hello(name: string): string {
    return `hi ${name}`;
  }
}

const root = new Context();
root.plugin(Greeter);
root.plugin(Loader);

root.inject(['greeter', 'loader'], (ctx) => {
  const viaGet: Greeter | undefined = ctx.get('greeter');
  const viaProp: string = ctx.greeter.hello('x');
  const loader: Loader = ctx.loader;
  // @ts-expect-error hello 收 string
  ctx.greeter.hello(1);
  // @ts-expect-error get('greeter') 是 Greeter | undefined，不是 number
  const wrong: number = ctx.get('greeter');
  // @ts-expect-error loader 不是 Greeter
  const notLoader: Greeter = ctx.loader;
  void [viaGet, viaProp, loader, wrong, notLoader];
});

// @ts-expect-error provide 回傳收尾函式，不是 number
const disposer: number = root.provide('greeter', new Greeter(root));
void disposer;

// provide：第一個重載帶型別；值型別不合時會落到 `provide(name: string, value?: any)`，**不報錯**。
// 這一行刻意不標 @ts-expect-error——報告把它列為「provide 的值型別沒有被檢查」。
root.provide('greeter', 42);
// inject：`Inject` 是 `(keyof Dict)[]`，名字打錯也不報錯。報告同列。
root.inject(['greeterr'], () => {});
