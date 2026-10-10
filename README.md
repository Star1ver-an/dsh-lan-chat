# 局域网好友聊天 · DSH Desktop 插件

独立安装、独立启停的 DeepSeek Harness 扩展。**这是社区自定义插件，并非 DeepSeek 官方插件。**

已验证环境：官方 **DSH Desktop 0.2.0-rc.2 / Windows x64**。其他系统尚未实机验证，升级 DSH 版本前请检查 peerDependencies 的兼容要求。

## 在另一台设备安装

1. 安装并打开对应版本的官方 DSH Desktop。
2. 打开左侧「插件」→ 安装，在包地址输入框粘贴：

```text
https://github.com/Star1ver-an/dsh-lan-chat/releases/download/v0.1.1/dsh-local-lan-chat-0.1.1.tgz
```

3. 安装并启用；如果提示重启，从「应用 → 退出」完全退出，再打开 DSH。左下角会出现「好友」。

若设备不能直接下载 GitHub Release，可先从 [Releases](https://github.com/Star1ver-an/dsh-lan-chat/releases/tag/v0.1.1) 下载 tgz，再把它的**本机绝对路径**粘贴到安装输入框。也支持从 GitHub 标签安装：

```text
github:Star1ver-an/dsh-lan-chat#v0.1.1
```

仓库和安装包已包含构建后的 `lib/`，安装无需 Node.js 开发环境，也无需执行构建脚本。另一个插件见 [德州扑克](https://github.com/Star1ver-an/dsh-poker)，两者互不依赖。个人数据和服务地址不包含在仓库或安装包中。

## 本次界面修复

好友浮层使用不透明的主题背景，避免底部入口透出并遮挡好友内容。

## 使用

保留原局域网发现、配对、好友列表、消息记录、AI 聊天工具和斜杠命令。各设备会使用自己的 DSH home，不会通过仓库同步个人身份或聊天记录。

- 配对：双方启用插件并允许可信局域网访问，默认 UDP 发现端口 41888，TCP 端口自动分配。
- AI 工具：`chat_friends`、`chat_send`、`chat_messages`。命令：`/friend`、`/msg`。
- 插件配置 `injectInto: none` 关闭好友消息对最近活动根会话的注入；`tools: false` 关闭 AI 工具。
- 无法广播时可配置 `lan.directPeers` 为 `IP:发现端口`。
- 沿用原 `chat` 存储域。同一 home 的旧版数据可读取；不要同时运行共享该 home 的两个聊天实例。
- 保持原局域网明文协议兼容，配对指纹不等于加密认证，适用于可信局域网。

在 DSH 插件管理器中可单独停用或卸载本插件。停用会清理该插件的界面贡献和连接，不删除已有个人数据。

## 开发和重新打包

源码在 `src/`，测试在 `tests/`，根目录的 `cordis.patch.yml` 是插件 bundle 入口。由官方 Host 提供的依赖声明为 peers，不在插件内安装另一份 Harness。

需要 Node.js 22+、pnpm，以及 0.2.0-rc.2 的官方 Desktop SDK：

```powershell
pnpm install --ignore-scripts --frozen-lockfile
node scripts/prepare-runtime.mjs
pnpm build
pnpm test
pnpm pack --pack-destination artifacts
```

`prepare-runtime.mjs` 默认只读解包 Windows 标准安装位置的 `resources/app.asar` 到被 Git 忽略的 `.runtime/`，不改官方应用。也可传入 `app.asar` 的绝对路径。若已有解包 SDK，可将环境变量 `DSH_RUNTIME` 设为其中的 `dsh/node_modules` 目录，供构建和测试共同使用。

依赖安装禁用自动补装 peers；运行时由 DSH 提供这些依赖。源码变化后重新构建，提交 `lib/`，重新打包并发布新版本。不要添加安装时自动编译的 prepare/postinstall 钩子。

## 验证与许可

独立仓库测试：135 项通过。原迁移已在官方 Desktop 实机验证独立启停、重启加载，并通过两个 loopback 实例验证 UDP/TCP 配对和收发。跨机器网络仍取决于双方在线状态、权限与路由。

从原 DeepSeek Harness 项目的自定义功能拆出，来源基线 `c589d9761f`；目标 SDK 为官方 0.2.0-rc.2。采用 [MIT](LICENSE) 许可；原作者许可保留，打包依赖见 [第三方许可](THIRD_PARTY_NOTICES.txt)。
