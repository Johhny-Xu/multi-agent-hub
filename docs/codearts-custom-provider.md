# CodeArts 使用已有 OpenAI 兼容路由

9router 的登录只负责上游模型认证。CodeArts 仍需先完成其官方身份认证和适用的自定义模型权限初始化；IDE 登录状态不能直接代替独立 CLI 的非交互认证。0.9.9 实测中两端 9router 认证成功，但 CodeArts 模型调用仍受阻，见 [修复记录](release-0.9.9-codearts-repair.json)。

使用官方界面完成账号设置后，将自定义 provider 合并进**用户私有配置**。CLI 文档使用 `~/.codeartsdoer/codearts_cli.json`；若已有 `.jsonc`，沿用原文件。IDE 对应 `~/.codeartsdoer/codearts-data/codearts.json`。先备份，不覆盖原有 provider、MCP 或模型配置，不把真实路由密钥放进项目。

```json
{
  "provider": {
    "my-router": {
      "name": "My OpenAI-compatible router",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://your-router.example/v1",
        "apiKey": "REPLACE_WITH_PRIVATE_ROUTER_KEY"
      },
      "models": {
        "your-model-id": {
          "id": "your-model-id",
          "name": "My model",
          "tool_call": true
        }
      }
    }
  }
}
```

模型 ID 必须取自实际路由目录，`tool_call` 也应符合其能力。先在 `codearts models` 中确认出现 `my-router/your-model-id`，再显式选择它执行短任务；收到有效回答后再考虑设为默认。目录为空或仍提示认证失败时，保留原默认模型，回到官方账号配置处理；不要手动改写内部 provider 权限过滤变量。

当前 Linux CLI 26.9.12 的非交互调用要求官方华为 AK/SK；9router key 不能替代它们。Windows 独立 IDE 内核未完成自定义 provider 注册，不代表用户在 IDE 内交互使用时没有权限。因此明早应分别检查 IDE 内模型可选状态，以及作为 Hub worker 的独立调用。

官方依据：[自定义模型配置](https://support.huaweicloud.com/usermanual-cli/codeartsagent_cli_00022.html)、[模型命令](https://support.huaweicloud.com/usermanual-cli/codeartsagent_cli_0026.html)、[官方 CLI 使用说明](https://support.huaweicloud.com/usermanual-cli/codeartsagent_cli_0025.html)。
