# op-anthropic-auth-v2

OpenCode 2 plugin for Anthropic OAuth with Claude Pro/Max.

> [!WARNING]
> This is an unofficial compatibility plugin. Anthropic may restrict third-party use
> of Claude subscription OAuth credentials, and using it could put your account at
> risk. Review Anthropic's current terms and use it at your own discretion.

Port of [op-anthropic-auth](https://github.com/leohenon/op-anthropic-auth) (MIT, by
leohenon) to the [OpenCode 2](https://opencode.ai/v2/docs) plugin API. The original
plugin targets OpenCode 1 and cannot load in v2 — this package is the v2 equivalent.

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

For OpenCode 1, keep using [op-anthropic-auth](https://github.com/leohenon/op-anthropic-auth).
Both can coexist: v1 ignores this package's format, v2 ignores the v1 package.

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
