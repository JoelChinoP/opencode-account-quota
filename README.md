# opencode-account-quota

OpenCode plugin to check how much quota each connected account has left, get a notice when one runs low, and keep a route order of accounts. Open it with `/quota`.

> Status: 0.1.0. Tested with OpenCode 2.3.2, 2.4.1 and 2.4.2. ChatGPT and Claude Code readings are experimental and use unofficial endpoints that may change.

## What it shows

| Account | Data | Default |
|---|---|---|
| DeepSeek | Balance per currency (official balance API) and a low-balance notice | On |
| ChatGPT (OpenAI OAuth) | 5 h and weekly usage of the Codex plan | Off: `experimentalCodexUsage` |
| Claude Code | 5 h and weekly usage of the single Claude Code profile (`claude -p /usage`) | Off: `experimentalClaudeUsage` |

`—` means no data, never zero usage. `●` marks the account in use.

The plugin does not switch accounts and does not touch credentials: logging in and changing accounts stay in OpenCode (`/connect`). Only your preferences (route order, notice thresholds) are saved; readings stay in memory. Opening the modal does not query any provider: press `r` to refresh the selected account or `a` for all of them.

## Install

```sh
git clone https://github.com/JoelChinoP/opencode-account-quota.git
```

Add it to `opencode.json` / `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/path/to/opencode-account-quota",
      "options": {
        "experimentalCodexUsage": false,
        "experimentalClaudeUsage": false,
        // Seconds ChatGPT and Claude Code usage stays fresh: integer 1–3600, default 150.
        "usageFreshnessSeconds": 150
      }
    }
  ]
}
```

Restart OpenCode and run `/quota` (or `Account quota and routing` from `Ctrl+P`).

Claude Code usage runs the `claude` binary from `PATH`, or `OPENCODE_CLAUDE_PATH` if set.

## Development

No dependencies are needed to run the tests:

```sh
node --test
```

## License

[MIT](LICENSE)
