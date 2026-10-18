# dsh-sysproxy / dsh-系统代理

跟随 Windows 系统代理的 dsh 插件。

插件页显示名：中文界面为 `dsh-系统代理`，英文界面为 `dsh-sysproxy`。

## 作用

1. 每 5 秒读取一次注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`。
2. 系统代理开启时，把 `ProxyServer` / `ProxyOverride` 装成 dsh 的进程级 HTTP 路由。
3. 系统代理关闭或改地址时，自动跟随，不需要重启。
4. 插件页开关关闭后，恢复 dsh 启动时的路由（直连）。

## 覆盖范围

| 出口 | 是否走系统代理 |
| :-- | :-- |
| 模型 API 请求（`fetch`） | 是 |
| `web_fetch` 工具 | 是（复用 dsh 自带 `dsh-http-proxy` 策略） |
| bash / MCP 等子进程 | 是（写入 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`） |
| localhost、`127.0.0.0/8`、`ProxyOverride` 列出的主机 | 否 |

## 不支持

- PAC 脚本（`AutoConfigURL`）。只打一条日志，然后直连。
- SOCKS 代理条目（`socks=...`）。跳过并记日志。
- 非 Windows 平台。插件直接空转。

## 注意

不要在 `~/.dsh/.env` 里写 `HTTP_PROXY` / `HTTPS_PROXY`。启动环境先于插件生效，会和本插件抢路由。需要固定代理时，直接开 Windows 系统代理。

## 安装

```sh
npx -y @deepseek-ai/dsh plugin --profile desktop add "file:C:/Users/user/WorkBuddy AI/dsh-sysproxy"
```

或者在桌面版的「添加插件」对话框里填本地路径。

装完重启 dsh。插件页出现 `dsh-sysproxy`，里面有开关。

## 配置

| 字段 | 类型 | 默认 | 说明 |
| :-- | :-- | :-- | :-- |
| `enabled` | boolean | `true` | 跟随系统代理。关闭后直连。改动立即生效，不需要重启。 |

## 说明

- 插件跑在 `dsh-desktop-host` 子进程里，拿不到 Electron 的 `Tray` 对象。所以托盘右键菜单没有加「重启」项。dsh 主进程也没有开放托盘扩展点。要重启应用，用托盘的「退出」后重新打开。
- 路由优先用 dsh 自带的 `@deepseek-ai/dsh-http-proxy`，这样全局 dispatcher、`web_fetch` 路由、子进程环境三处一致。找不到该包时退回插件内置的 undici dispatcher。
