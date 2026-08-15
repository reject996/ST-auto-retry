# 自动重试

SillyTavern 前端拓展。它只处理聊天补全生成请求：
`POST /api/backends/chat-completions/generate`。

## 模式

- **不启用**：不干预请求，默认模式。
- **特定报错与空回**：HTTP `429`、HTTP `503`、响应体内的 `429/503` 错误，以及成功响应中的空消息会重试。兼容 SillyTavern 将上游错误包装成 HTTP `200` 和 `Service Unavailable` / `Too Many Requests` 消息的情况。
- **全部情况**：任意 HTTP 错误、响应体错误、网络失败和空消息都会重试。

工具调用、函数调用、图片或音频响应不视为空回。拓展会完整检查流式响应后再交给 SillyTavern，避免重试时重复已经显示的片段，因此开启重试后流式文本会在一轮响应完成后一次性出现。

对于 OpenAI 兼容响应，`choices[].message.content` 为 `""`、仅空格、仅换行或其他纯空白字符串时，均视为空回；`extra_content` 等元数据不会让空消息被误判为有效回复。

## 设置

- **最高重试 RPM**：所有聊天补全请求共享的重试速率上限，默认 `5`。第一次重试可以立即发生，后续重试按此速率排队；服务端 `Retry-After` 会优先采用更长等待时间。
- **最高单次重试次数**：一次原始请求最多增加的尝试次数，默认 `5`。例如设为 `5` 时，最多发送 `1` 次原始请求和 `5` 次重试。

## 安装

在 SillyTavern 的“扩展”面板中点击“安装扩展”，输入以下 Git URL：

```text
https://github.com/xfcgef/ST-auto-retry
```

也可以将整个 `auto-retry` 文件夹放到：

```text
SillyTavern/public/scripts/extensions/third-party/auto-retry
```

重启 SillyTavern，然后在“扩展”设置中展开“自动重试”。

## 手动测试

1. 保持默认“不启用”，确认普通聊天请求只发送一次。
2. 选择“特定报错与空回”，将 RPM 和重试次数暂时设为较小值。
3. 让测试代理依次返回 HTTP `429`、HTTP `503`、`200` 空消息和 `200` 正常消息。
4. 在浏览器开发者工具的 Network 面板中确认生成请求按设置重发，正常消息到达后停止。
5. 改为“全部情况”，用 HTTP `500` 验证它也会重试；切回“特定报错与空回”后，HTTP `500` 应直接交给酒馆。
6. 在流式模式下返回只有 `data: [DONE]` 的 SSE，再返回带内容的 SSE，确认只显示最终的非空回复。

运行核心自动化测试：

```powershell
node --test core.test.mjs
```
