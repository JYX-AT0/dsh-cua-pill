# bin/ — backend binary goes here (not tracked)

This directory is intentionally empty in the repository.

Put your own Computer Use MCP server executable here, named `cua-server.exe`
by default, or point the proxy elsewhere with any of:

| Mechanism | Example |
|---|---|
| `CUA_SERVER` env var | `CUA_SERVER=D:\tools\cua-server.exe` |
| `bin/` drop-in | copy your binary to `bin\cua-server.exe` |
| `CUA_SERVER_NAME` | expects a different filename inside `bin/` |

## Why is no binary bundled?

The reference backend is a **closed-source, commercially licensed component**
distributed by its own vendor. Redistributing it in a public repository is not
permitted by that vendor's terms, so this project ships only the code it owns:
the JSON-RPC proxy and the Electron overlay.

If you do not own a licensed copy of a Computer Use backend, you can write your
own MCP server implementing the same tool surface (`list_apps`, `list_windows`,
`get_window`, `launch_app`, `activate_window`, `get_window_state`, `click`,
`drag`, `scroll`, `press_key`, `type_text`, `set_value`,
`perform_secondary_action`, `run_steps`) on top of UI Automation / pyautogui.
`proxy.mjs` does not care who wrote the server, as long as it speaks
**stdio JSON-RPC 2.0** and answers `tools/list` and `tools/call`.

## A note on naming

This project deliberately keeps no vendor's product name in its own package
name, description, keywords, or default filenames. The only place a
third-party name appears is a documented **interoperability fallback path**
that detects a backend already installed on the user's machine — the minimum
needed to talk to it, and not a claim of affiliation or endorsement.
