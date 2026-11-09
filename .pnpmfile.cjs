/* global module */
module.exports = {
  hooks: {
    readPackage(pkg) {
      // `@langchain/langgraph-sdk` 把 vue 列為選用 peer，pnpm 會把 apps/web 測試頁用的 vue 解析進 harness，`pnpm deploy`
      // 的出貨包就帶上 vue（#2366）。只比套件名，升版後照樣生效。
      // TODO(#2336)：拿掉 LangChain 時刪掉這個檔。
      if (pkg.name === '@langchain/langgraph-sdk') {
        delete pkg.peerDependencies?.vue;
        delete pkg.peerDependenciesMeta?.vue;
      }
      return pkg;
    },
  },
};
