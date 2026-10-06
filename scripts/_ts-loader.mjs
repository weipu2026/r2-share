/**
 * Node 的 ESM 解析钩子：把无扩展名的相对 import 落到 .ts 文件。
 *
 * 为什么需要：src/index.ts 内部用的是打包器风格的 `import ... from './views'`，
 * 而 Node 原生 ESM 不做扩展名补全（--experimental-specifier-resolution 已移除）。
 * 只有**测试**需要这个补全，生产由 wrangler/esbuild 打包，因此这里用钩子而不是
 * 去动产品代码的 import 风格。
 *
 * 用法：node --import ./scripts/_ts-loader-register.mjs scripts/test-routes.mjs
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    // 只兜「相对路径且没有扩展名」这一种：'./views' → './views.ts'
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      return nextResolve(specifier + '.ts', context);
    }
    throw err;
  }
}
