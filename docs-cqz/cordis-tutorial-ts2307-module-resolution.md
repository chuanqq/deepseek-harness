# Cordis 教程 TS2307 模块解析问题排查与修复

## 现象

在 `tmp/cordis-tutorial/hello.ts` 中：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello'

export function apply(ctx: Context) {
  throw new Error('apply exploded!')
}
```

TypeScript 报告：

```
TS2307: Cannot find module '@deepseek-ai/cordis' or its corresponding type declarations.
```

## 产生原因

`@deepseek-ai/cordis` 不是从 npm registry 安装的普通依赖，而是本仓库 `vendor/cordis/` 下的 vendored workspace 包。

仓库通过根目录 `tsconfig.base.json` 中的 `paths` 把它映射到源码：

```json
"@deepseek-ai/cordis": ["./vendor/cordis/src"]
```

但 `tmp/cordis-tutorial/hello.ts` 位于 `tmp/` 下，而：

- 根 `tsconfig.json` 是 `files: []` 的 solution 配置；
- `tsconfig.host.json` / `tsconfig.client.json` 没有包含 `tmp/`；
- `tmp/cordis-tutorial/` 下也没有自己的 `tsconfig.json`。

因此 TypeScript 在检查这个文件时没有应用仓库的 `paths` 映射，又找不到真实的 `node_modules/@deepseek-ai/cordis`，于是报模块无法解析。

运行时不受影响：`import type` 是纯类型导入，运行时会被擦除；教程使用的 `node --import tsx ../../vendor/cordis/bin.js` 能正常加载插件。

## 修复方法

在 `tmp/cordis-tutorial/` 下新增 `tsconfig.json`，让该目录成为独立的 TypeScript 项目，并继承 Cordis 自身的编译选项和路径映射。

```json
{
  "extends": "../../vendor/cordis/tsconfig.json",
  "compilerOptions": {
    "composite": false,
    "declaration": false,
    "declarationMap": false,
    "incremental": false,
    "noEmit": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "rootDir": "../.."
  },
  "include": ["**/*.ts"]
}
```

关键点：

- `extends: "../../vendor/cordis/tsconfig.json"`：继承 Cordis 的编译选项和 `paths`，使 `@deepseek-ai/cordis` 解析到 `vendor/cordis/src`。
- `include: ["**/*.ts"]`：把 `tmp/cordis-tutorial/` 下的 TypeScript 文件纳入当前项目。
- `rootDir: "../.."`：允许项目同时包含 `tmp/` 与 `vendor/` 下的源码文件。
- `noEmit: true`：只做类型检查，不生成编译产物。
- 关闭 `noUnusedLocals` / `noUnusedParameters`：避免当前 `hello.ts` 中 `ctx` 参数未使用导致额外的 TS6133 噪音。

如果你希望保留严格检查，可以不关闭 `noUnusedParameters`，并把函数签名改为：

```ts
export function apply(_ctx: Context) {
  throw new Error('apply exploded!')
}
```

## 验证

在仓库根目录执行：

```sh
pnpm exec tsc -p tmp/cordis-tutorial/tsconfig.json --noEmit
```

修复后 `TS2307` 消失，类型检查通过。
