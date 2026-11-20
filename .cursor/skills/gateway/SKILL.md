---
name: gateway
description: >-
  Rules for the my-sub-api relay. Use when changing providers, /v1/messages
  translation, tools, tool_choice, model routing, or adding an upstream.
  Clients and models are not known ahead of time.
---

# 通用中转

客户端和模型都不能假设。不要为 Grok、千问、DeepSeek 再加一条分支，除非这家上游的文档写明某种请求会 400，并且未知上游不走这条分支。

## 协议

`/v1/messages` 的协议看上游配置 `messages`：`chat`、`responses`、`anthropic`。没写才按地址猜，猜不到就是 `chat`。

新上游把协议写进 `PROVIDERS`，不要改 `messagesWire` 的模型名前缀。OpenCode 一个地址拆成三种协议，是现有的地址猜测，不要照这个模式给别的厂商加 `startsWith("模型名")`。

## 工具

按协议，不按厂商：

- 客户端函数工具（有名字，类型为空、`custom` 或 `function`）一律保留。
- 服务端工具（`web_search_YYYYMMDD`、`web_fetch`、代码执行、tool search、computer）默认丢掉。
- 只有确认该上游会自己执行时才映射。Responses 的托管 `web_search` 用配置 `hostedSearch`；不写时只认 xAI 和 OpenAI。
- 官方 Anthropic 原样转发。其他走 anthropic 协议的上游都要滤掉服务端工具。
- 工具被丢掉之后，点名它的 `tool_choice` 一起改掉：还有别的工具就用 `auto`，一个不剩就把 `tools` 和 `tool_choice` 都拿掉。

## 不要动的名单

`modelAllowed` 里 OpenCode、xAI 的模型白名单是套餐计费，不是协议。新上游默认放行全部模型。
