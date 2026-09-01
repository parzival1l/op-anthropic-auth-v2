# op-anthropic-auth-v2

[![npm](https://img.shields.io/npm/v/op-anthropic-auth-v2?style=flat-square&logo=npm&logoColor=white&label=npm&color=teal)](https://www.npmjs.com/package/op-anthropic-auth-v2)

OpenCode 2 plugin for Anthropic OAuth with Claude Pro/Max.

## Origin and attribution

This package is adapted from
[op-anthropic-auth](https://github.com/leohenon/op-anthropic-auth) version `0.1.4`,
created by [leohenon](https://github.com/leohenon) and released under the MIT
License. The original project's authentication approach, request shaping, and
plugin design form the basis of this package.

This adaptation ports that work to the OpenCode 2 plugin API. It is maintained as
a separate package and is not an official OpenCode 2 release from the original
author. The [license](./LICENSE) retains credit for the original work.

> [!WARNING]
> This is an unofficial compatibility plugin. Anthropic may restrict third-party use
> of Claude subscription OAuth credentials, and using it could put your account at
> risk. Review Anthropic's current terms and use it at your own discretion.

## What it does

OpenCode 2 beta sends Anthropic OAuth requests as-is, and Anthropic rejects them with
an opaque `429` (`{"message":"Error"}`). This plugin rewrites every request to
`api.anthropic.com` so it passes OAuth gating:

- sets the `claude-cli` user-agent and required `anthropic-beta` headers
- adds the `x-anthropic-billing-header` system block
- prepends the Claude Code identity to the system prompt and relocates remaining
  system text into the first user message
- prefixes tool names with `mcp_` and rewrites the response stream back
- refreshes the OAuth token on expiry and persists it to the shared
  `~/.local/share/opencode/auth.json`

## Install

```sh
opencode2 plugin add op-anthropic-auth-v2
```

or add it to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": ["op-anthropic-auth-v2"]
}
```

Requires existing Anthropic OAuth credentials (`opencode2 auth login`, or credentials
already stored by OpenCode 1 in `~/.local/share/opencode/auth.json`). Users with a
plain API key are unaffected — the plugin leaves non-OAuth setups untouched.

This adaptation only targets OpenCode 2. OpenCode 1 users should use the original
[op-anthropic-auth](https://github.com/leohenon/op-anthropic-auth) package.

## Compatibility

Built against `opencode2` `0.0.0-beta-18743`. Version `0.1.1` reports Claude Code
`2.1.257` to meet Anthropic's model compatibility check. The v2 plugin API is beta
and may change; pin accordingly.

## Development

```sh
npm test
npm run check
npm run pack:dry-run
```
