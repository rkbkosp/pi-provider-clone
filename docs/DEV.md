# Pi Provider Clone Extension — DEV.md

> 状态：v1 实现完成，首发版本 v0.1.0
> 目标平台：`earendil-works/pi`
> 参考实现快照：`main`，tag **v0.81.1 **commit 20be4b1
> 扩展形态：Pi 全局 TypeScript extension

## 1. 背景

Pi 当前以 `providerId` 为凭证存储键。一个 provider 只能对应一份存储凭证，因此同一个 provider 无法原生并列保存两个 OAuth 登录态或两把 API Key。

本扩展通过“克隆 provider”解决该问题：

* 克隆 provider 复用源 provider 的端点、认证流程、API 实现和模型定义；
* 克隆 provider 使用新的 provider ID；
* Pi 因此会把凭证保存到新的 provider ID 下；
* 用户可在原生 `/model` 选择器中，按 provider 区分同名模型；
* 模型 ID、模型名称和模型能力保持不变。

典型用途：

```text
openai-codex/gpt-5.5
openai-codex-personal/gpt-5.5
openai-codex-work/gpt-5.5
```

## 2. 已确认的 Pi 行为

### 2.1 模型身份

Pi 不以 `model.id` 作为全局唯一标识。

模型身份是：

```ts
providerId + modelId
```

因此下列模型可以同时存在：

```text
gpt-5.5 [openai-codex]
gpt-5.5 [openai-codex-personal]
```

扩展不得：

* 给模型 ID 加后缀；
* 给模型名称加后缀；
* 建立额外模型 ID 映射；
* 修改模型能力、上下文窗口、费用或 thinking level 配置。

克隆时只修改：

```ts
model.provider
```

### 2.2 原生模型选择器

Pi 原生 `/model` 选择器会显示 provider 徽标：

```text
gpt-5.5 [openai-codex]
gpt-5.5 [openai-codex-personal]
```

搜索文本包含：

```text
provider
provider/modelId
modelId
model.name
```

v1 不开发自定义模型选择器。用户继续使用 `/model`，并通过 provider 筛选模型。

### 2.3 凭证存储

Pi 的凭证存储按 provider ID 读写：

```json
{
  "openai-codex": {
    "type": "oauth"
  },
  "openai-codex-personal": {
    "type": "oauth"
  }
}
```

克隆 provider 注册后，用户运行：

```text
/login openai-codex-personal
```

凭证应写入 `openai-codex-personal`，不得覆盖 `openai-codex`。

## 3. v1 用户体验

### 3.1 创建克隆

用户运行：

```text
/clone-provider
```

交互流程：

1. 显示可克隆的源 provider；
2. 用户选择源 provider；
3. 输入新的 provider ID；
4. 校验 ID；
5. 注册克隆 provider；
6. 保存克隆定义；
7. 提示用户登录新 provider；
8. 用户通过 `/model` 选择克隆 provider 下的模型。

示例：

```text
/clone-provider

Select source provider:
> OpenAI Codex (openai-codex)
  Anthropic (anthropic)
  OpenRouter (openrouter)

New provider ID:
openai-codex-personal

Provider "openai-codex-personal" cloned from "openai-codex".
Run /login openai-codex-personal, then use /model to select a model.
```

### 3.2 Provider ID 规则

v1 将用户输入同时作为：

* provider ID；
* provider 显示名称。

允许：

```regex
^[a-z0-9][a-z0-9._-]*$
```

拒绝：

* 空字符串；
* 大写字母；
* 空格；
* `/`；
* 以 `.`、`_`、`-` 开头；
* 已存在的 provider ID；
* 与其他克隆 target ID 冲突；
* source ID 与 target ID 相同。

错误示例：

```text
Provider ID must match: ^[a-z0-9][a-z0-9._-]*$
```

v1 不单独询问显示名称。后续版本可添加可选 display name。

## 4. v1 范围

### 4.1 必须实现

* `/clone-provider` 命令；
* 从当前模型注册表生成源 provider 列表；
* Provider ID 输入和校验；
* 克隆静态模型快照；
* 复用源 provider 的 auth；
* 复用源 provider 的 base URL 和 headers；
* 包装 `stream`；
* 包装 `streamSimple`；
* 在源 provider 与克隆 provider 之间转换模型和历史消息身份；
* 转换输出事件中的 provider；
* 保存克隆定义；
* 扩展启动或 `/reload` 时恢复克隆；
* 重复加载幂等；
* 完整错误提示；
* 单元测试和手工验收测试。

### 4.2 暂不实现

* 自动账号轮询；
* 遇到 429 或额度耗尽时自动切换；
* 请求级负载均衡；
* 多凭证放在同一 provider ID 下；
* 修改 Pi 的 `auth.json` 格式；
* 自定义 `/model` UI；
* 模型名称后缀；
* 模型 ID 映射；
* 动态复制源 provider 的远程模型刷新闭包；
* `/delete-cloned-provider`；
* `/rename-cloned-provider`；
* 克隆 provider 再次被克隆；
* 自动触发 `/login`；
* 自动复制已有凭证。

## 5. 文件结构

建议扩展先按单文件 MVP 开发，稳定后再拆分。

### 5.1 MVP

```text
~/.pi/agent/extensions/provider-clone.ts
~/.pi/agent/provider-clones.json
```

### 5.2 推荐模块化结构

```text
provider-clone/
├── index.ts
├── clone-provider.ts
├── stream-bridge.ts
├── persistence.ts
├── validation.ts
└── types.ts
```

加载入口：

```text
~/.pi/agent/extensions/provider-clone/index.ts
```

## 6. 持久化格式

文件位置：

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/provider-clones.json
```

数据格式：

```json
{
  "version": 1,
  "clones": [
    {
      "sourceId": "openai-codex",
      "targetId": "openai-codex-personal",
      "createdAt": "2026-07-24T12:00:00.000Z"
    }
  ]
}
```

TypeScript：

```ts
export interface ProviderCloneDefinition {
  sourceId: string;
  targetId: string;
  createdAt: string;
}

export interface ProviderCloneStore {
  version: 1;
  clones: ProviderCloneDefinition[];
}
```

约束：

* 不保存 token；
* 不保存 API Key；
* 不复制 `auth.json`；
* 不持久化模型快照；
* 启动时始终从当前 source provider 重新构建 clone；
* 写入使用临时文件加 rename，避免部分写入；
* 读取失败时保留错误信息，不覆盖损坏文件；
* 未找到文件时视为空配置；
* 文件权限建议设为 `0600`，尽管文件不含凭证。

## 7. Provider 枚举

扩展 API 没有必要依赖内部 `ModelRuntime.getProviders()`。

通过模型注册表获取 provider ID：

```ts
function listCloneableProviders(ctx: ExtensionCommandContext) {
  const ids = [
    ...new Set(
      ctx.modelRegistry
        .getAll()
        .map((model) => model.provider),
    ),
  ];

  return ids
    .map((id) => ({
      id,
      name: ctx.modelRegistry.getProviderDisplayName(id),
      provider: ctx.modelRegistry.getProvider(id),
    }))
    .filter(
      (item): item is {
        id: string;
        name: string;
        provider: Provider;
      } => item.provider !== undefined,
    )
    .sort((a, b) =>
      `${a.name} ${a.id}`.localeCompare(`${b.name} ${b.id}`),
    );
}
```

UI label：

```ts
`${name} (${id})`
```

v1 仅展示拥有至少一个模型的 provider。

如果 source provider 已经是本扩展创建的 clone，则不显示，避免 clone-of-clone。

## 8. Clone 构建规则

### 8.1 模型快照

创建 clone 时读取：

```ts
source.getModels()
```

构建不可变快照：

```ts
const clonedModels = source.getModels().map((model) => ({
  ...model,
  provider: targetId,
}));
```

必须保留：

* `id`
* `name`
* `api`
* `baseUrl`
* `headers`
* `reasoning`
* `input`
* `cost`
* `contextWindow`
* `maxTokens`
* `thinkingLevelMap`
* `compat`
* 其他未来新增字段

因此应使用对象展开，不要手工白名单重建 Model。

### 8.2 Provider 字段

克隆 provider 应包含：

```ts
{
  id: targetId,
  name: targetId,
  baseUrl: source.baseUrl,
  headers: source.headers,
  auth: source.auth,
  getModels: () => clonedModels,
  filterModels: wrappedFilterModels,
  stream: wrappedStream,
  streamSimple: wrappedStreamSimple
}
```

### 8.3 不复制 refreshModels

不得直接写：

```ts
refreshModels: source.refreshModels
```

原因：

* 内置 provider 可能被远程 catalog wrapper 包装；
* `refreshModels` 可能闭包捕获原 provider ID；
* 可能访问源 provider 的 catalog URL；
* 可能读写错误的 models-store scope；
* 可能与源 provider 共享动态状态。

v1 使用启动时模型快照。

扩展 `/reload` 或 Pi 重启后会重新从 source provider 创建快照。

## 9. Source/Clone 身份桥接

### 9.1 为什么需要桥接

部分 provider API 实现可能根据 `model.provider` 执行兼容逻辑。

已知 Codex API 内部存在 provider ID 白名单：

```ts
new Set(["openai", "openai-codex", "opencode"])
```

自定义 clone ID 不在其中。

如果直接把：

```ts
model.provider = "openai-codex-personal"
```

传入源 Codex stream，普通首轮请求可能工作，但多轮工具调用和历史重放可能错误处理 Responses tool-call ID。

因此：

* Pi 外部看到 target provider；
* 源 API 实现内部看到 source provider；
* 请求前转换到 source；
* 响应后转换回 target。

### 9.2 转换 Model

```ts
function toSourceModel<TApi extends Api>(
  model: Model<TApi>,
  sourceId: string,
): Model<TApi> {
  return {
    ...model,
    provider: sourceId,
  };
}
```

### 9.3 转换 Context

只转换由当前 clone 产生的 assistant messages：

```ts
function toSourceContext(
  context: Context,
  sourceId: string,
  targetId: string,
): Context {
  return {
    ...context,
    messages: context.messages.map((message) => {
      if (
        message.role === "assistant" &&
        message.provider === targetId
      ) {
        return {
          ...message,
          provider: sourceId,
        };
      }

      return message;
    }),
  };
}
```

不得把其他 provider 的历史统一改成 source。

例如从账号 A 切到账号 B：

```text
openai-codex-personal
→ openai-codex-work
```

账号 A 的历史在账号 B 请求中应继续被识别为跨 provider 历史。

### 9.4 转换 AssistantMessage

```ts
function toTargetAssistantMessage(
  message: AssistantMessage,
  sourceId: string,
  targetId: string,
): AssistantMessage {
  if (message.provider !== sourceId) {
    return message;
  }

  return {
    ...message,
    provider: targetId,
  };
}
```

### 9.5 转换事件流

使用 Pi 导出的：

```ts
createAssistantMessageEventStream()
```

包装源 stream。

必须覆盖所有包含 assistant message 的事件类型，使用 TypeScript exhaustive switch，禁止依赖 JSON 字符串替换。

实现时以当前安装版本的 `AssistantMessageEvent` 类型为准调整事件分支。

## 10. Stream 包装

```ts
function createClonedProvider(
  source: Provider,
  targetId: string,
): Provider {
  const sourceId = source.id;

  const clonedModels = source.getModels().map((model) => ({
    ...model,
    provider: targetId,
  }));

  return {
    id: targetId,
    name: targetId,
    baseUrl: source.baseUrl,
    headers: source.headers,
    auth: source.auth,

    getModels: () => clonedModels,

    filterModels: source.filterModels
      ? (models, credential) => {
          const sourceModels = models.map((model) => ({
            ...model,
            provider: sourceId,
          }));

          const allowed = source.filterModels!(
            sourceModels,
            credential,
          );

          const allowedIds = new Set(
            allowed.map((model) => model.id),
          );

          return models.filter((model) =>
            allowedIds.has(model.id),
          );
        }
      : undefined,

    stream(model, context, options) {
      const inner = source.stream(
        toSourceModel(model, sourceId),
        toSourceContext(context, sourceId, targetId),
        options,
      );

      return bridgeStream(inner, sourceId, targetId);
    },

    streamSimple(model, context, options) {
      const inner = source.streamSimple(
        toSourceModel(model, sourceId),
        toSourceContext(context, sourceId, targetId),
        options,
      );

      return bridgeStream(inner, sourceId, targetId);
    },
  };
}
```

注意：

* 凭证由 Pi 在调用 clone provider 前按 `targetId` 解析；
* `options.apiKey` 已经是 target provider 的凭证；
* source stream 只负责使用传入的凭证发请求；
* 不要在 wrapper 中读取源 provider 凭证；
* 不要把 target 凭证复制到 source provider 的存储键；
* 不要直接调用 `ctx.modelRegistry.getApiKeyForProvider(sourceId)`。

## 11. filterModels 包装

不能直接传递：

```ts
filterModels: source.filterModels
```

包装逻辑：

1. clone models 映射回 source provider；
2. 调用 source filter；
3. 按返回模型 ID 筛选 clone models；
4. 返回的模型仍属于 target provider。

v1 假定同一 provider 内 model ID 唯一。

## 12. 命令要求

```ts
pi.registerCommand("clone-provider", {
  description: "Clone a provider under a new provider ID",
  handler: async (_args, ctx) => {
    await ctx.waitForIdle();

    // 1. 读取持久化定义
    // 2. 枚举非 clone 的 source providers
    // 3. ctx.ui.select()
    // 4. ctx.ui.input()
    // 5. 校验 target ID
    // 6. createClonedProvider()
    // 7. pi.registerProvider()
    // 8. 原子保存定义
    // 9. 保存失败时 pi.unregisterProvider() 回滚
    // 10. 提示 /login 和 /model
  },
});
```

要求：

* 用户取消 select/input 时不提示错误；
* 注册成功但持久化失败时回滚注册；
* 不自动切换模型；
* 不自动登录；
* 不自动复制 source credential。

## 13. 启动恢复

v1 在 `session_start` 恢复：

```ts
let restored = false;

pi.on("session_start", async (_event, ctx) => {
  if (restored) return;

  const store = await loadCloneStore();

  for (const clone of store.clones) {
    const source = ctx.modelRegistry.getProvider(
      clone.sourceId,
    );

    if (!source) {
      ctx.ui.notify(
        `Cannot restore provider clone "${clone.targetId}": ` +
          `source "${clone.sourceId}" is unavailable.`,
        "warning",
      );
      continue;
    }

    if (ctx.modelRegistry.getProvider(clone.targetId)) {
      continue;
    }

    pi.registerProvider(
      createClonedProvider(source, clone.targetId),
    );
  }

  restored = true;
});
```

`registerProvider()` 在初始加载后调用会立即生效，不要求额外 `/reload`。

## 14. 幂等性

以下操作不得造成重复或覆盖：

* Pi 启动；
* `/reload`；
* session resume；
* session fork；
* 多次触发 `session_start`；
* 重复执行恢复逻辑。

规则：

```ts
if (ctx.modelRegistry.getProvider(targetId)) {
  // 已存在则跳过
}
```

同时维护：

```ts
const registeredCloneIds = new Set<string>();
```

如果 target ID 被其他扩展或 `models.json` 占用：

* 不覆盖；
* 输出 warning；
* 保留持久化定义；
* 等用户手动解决冲突。

## 15. API Key Provider 行为

克隆 API Key provider 后：

* clone 复用 source 的 API key 登录流程；
* `/login clone-id` 将 key 存入 clone ID；
* source auth 支持环境变量 fallback 时，clone 未登录也可能读取相同环境变量；
* v1 接受该行为，因为这是 source auth 的原始语义。

文档中明确建议：

```text
Run /login <clone-id> to store a separate credential.
```

不要为阻止环境变量 fallback 而修改 source auth。

## 16. OAuth Provider 行为

克隆 OAuth provider 后：

* clone 复用 OAuth login；
* clone 复用 OAuth refresh；
* clone 复用 OAuth token-to-auth 转换；
* Pi 使用 target ID 存储和刷新 credential；
* source 和 target token 互不覆盖。

重点验证：

* 两个 ChatGPT 账号分别登录；
* 两个 refresh token 分开存储；
* 一个 clone logout 不影响 source；
* token 过期后由 Pi 正常刷新。

## 17. 错误处理

必须覆盖：

* Source provider 消失；
* Target ID 冲突；
* Source 无模型；
* 持久化 JSON 损坏；
* Provider 注册失败；
* Stream bridge 失败；
* 保存失败后的注册回滚。

Stream bridge 出错时必须以 Pi 可识别的 error event 结束 outer stream，不能让 outer stream永久 pending。

## 18. 测试

### 18.1 单元测试

覆盖：

* Provider ID 验证；
* 模型复制只改变 provider；
* Context 只转换当前 clone 的 assistant 历史；
* start/update/done/error 事件转换；
* `filterModels` 转换；
* 配置文件读取、损坏处理和原子写入；
* 重复定义和 target 冲突；
* 恢复逻辑幂等。

### 18.2 Codex smoke test

两个 provider 分别完成：

1. 普通对话；
2. 模型调用 bash/read；
3. 工具返回；
4. 模型继续响应；
5. 下一轮继续引用历史工具调用。

重点检查：

* 无 Responses item ID 错误；
* 无 function call pairing 错误；
* 无 previous response 错误；
* session history 中 assistant provider 保存为 target ID。

### 18.3 会话内切换账号

流程：

```text
openai-codex
→ 产生消息和工具调用
→ openai-codex-personal
→ 继续对话
→ 切回 openai-codex
```

预期：

* 不崩溃；
* 跨 provider 历史正确降级；
* 两个账号使用各自 credential；
* 输出 provider 与当前所选 provider 一致。

## 19. 完成标准

v1 完成必须同时满足：

* `/clone-provider` 可创建 clone；
* clone 定义可跨重启恢复；
* source 和 target 可保存不同凭证；
* 原生 `/model` 可区分同名模型；
* 模型 ID 和 name 不变；
* Codex 普通对话通过；
* Codex 连续工具调用通过；
* session 内账号切换通过；
* logout 隔离通过；
* TypeScript 无类型错误；
* 没有修改 Pi 上游源码；
* 没有读写 source credential；
* 没有 token 泄漏到 `provider-clones.json`；
* 所有失败路径不会留下“已注册但未持久化”的半完成状态。

## 20. 开发顺序

### P0：最小闭环

1. 持久化 schema；
2. Provider ID 校验；
3. Provider 枚举；
4. 静态模型 clone；
5. `/clone-provider`；
6. 注册与保存；
7. 启动恢复；
8. API Key provider smoke test。

### P1：Provider 身份桥接

1. Model 转换；
2. Context 转换；
3. AssistantMessage 转换；
4. Event stream bridge；
5. `stream` 包装；
6. `streamSimple` 包装；
7. Codex 普通对话测试；
8. Codex 工具调用测试。

### P2：稳定性

1. `filterModels` 包装；
2. 原子写入；
3. 完整回滚；
4. 幂等恢复；
5. 损坏配置处理；
6. 单元测试；
7. 文档和安装说明。

## 21. 给 Codex 的执行要求

* 先读取当前安装版本的 Pi 类型定义，不要假设事件字段；
* 优先使用公开 extension API；
* 不 import `packages/coding-agent/src/...` 内部路径；
* 不 patch Pi 源码；
* 不改 `auth.json`；
* 不添加模型后缀；
* 不复制 `refreshModels`；
* 不在日志中打印凭证；
* 每完成一个阶段运行类型检查；
* 为 Codex 连续工具调用增加真实 smoke test；
* 如果公开 API 无法安全构造 terminal error event，先记录阻塞点，不要用 `as any` 静默绕过核心流控制。

