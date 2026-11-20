# Pi Token Speed Rainbow

一个轻量、零配置的 [Pi Coding Agent](https://pi.dev/) 扩展，在状态栏实时显示模型的 token 输出速度。

```text
⚡ 42.3 tok/s
```

显示文字使用彩虹渐变色，并在响应结束后保留本轮平均速度。

## 特点

- 零配置，安装后自动启用
- 零运行时依赖
- 不替换 Pi 的内置 footer，只添加一个 status 项
- 不读写配置、不访问网络、不记录会话内容
- 实时统计 text、thinking 和 tool-call 参数输出
- 流式期间使用 2.5 秒滑动窗口
- 150ms UI 刷新节流，避免频繁重绘
- 响应完成后优先使用 provider 返回的 `usage.output`
- 支持 truecolor 和 256 色终端

## 安装

```sh
pi install git:github.com/bottomash/token-speed
```

安装后重新启动 Pi，或在 Pi 中运行：

```text
/reload
```

## 卸载

```sh
pi remove git:github.com/bottomash/token-speed
```

## 测量口径

- 实时速度从首个输出 delta 开始计算，不包含 TTFT。
- 实时 token 数按字符类别估算：CJK/全角字符和其他字符使用不同权重。
- 回复完成后，若 provider 提供 `usage.output`，会使用真实输出 token 总数计算最终平均速度。
- 网络缓冲和 provider 的 chunk 粒度可能影响实时值；本扩展适合作为速度观察工具，不用于严格 benchmark。

## 手动安装

也可以只复制源码：

```text
extensions/index.ts → ~/.pi/agent/extensions/token-speed.ts
```

## License

[MIT](LICENSE)

---

## English

A lightweight, zero-configuration Pi extension that displays live token generation speed in the status bar with rainbow colors.

It has no runtime dependencies, does not replace Pi's built-in footer, performs no network or configuration-file access, and throttles UI updates to once every 150ms.

Install with:

```sh
pi install git:github.com/bottomash/token-speed
```
