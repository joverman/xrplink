# Publishing XRPLink to the official MCP Registry

This repo includes a `server.json` for the remote Streamable HTTP server at `https://xrp-link.com/mcp`. **Do not publish from CI or from an agent.** The founder must run these commands locally after reviewing `server.json`.

This change does **not** publish, deploy, or register the server.

## Namespace choice

`server.json` uses **`io.github.joverman/xrplink`**.

| Namespace | How you prove ownership | Trade-off |
|-----------|-------------------------|-----------|
| `io.github.joverman/xrplink` (chosen) | `mcp-publisher login github` — GitHub device flow as user `joverman` | Fastest path. Matches this GitHub repo. Registry does **not** prove you control `xrp-link.com`. |
| `com.xrp-link/xrplink` | DNS or HTTP challenge on `xrp-link.com` (`mcp-publisher login dns` or `http`) | Better if you want the registry name to match the product domain. Extra one-time domain verification. Same remote URL either way. |

The registry checks the **namespace** in `name`, not that the remote URL is on that domain. Each remote URL can only be claimed by one server name. Switching later means a new name, not a rename in place.

Description is kept under the registry's 100-character limit.

## Steps (founder, on a machine with a browser)

Install `mcp-publisher` (macOS/Linux):

```bash
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
sudo mv mcp-publisher /usr/local/bin/
mcp-publisher --help
```

Homebrew alternative: `brew install mcp-publisher`.

From the repository root (this directory, with `server.json`):

```bash
# 1. Validate only — does not publish
mcp-publisher validate

# 2. Authenticate as GitHub user joverman (required for io.github.joverman/*)
mcp-publisher login github
# Follow the printed URL + device code, then return here

# 3. Publish metadata (does not deploy xrp-link.com)
mcp-publisher publish
```

Confirm:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.joverman/xrplink"
```

To use the domain namespace instead, change `"name"` in `server.json` to `com.xrp-link/xrplink`, then:

```bash
mcp-publisher login dns
# complete the DNS/HTTP challenge for xrp-link.com
mcp-publisher validate
mcp-publisher publish
```

Do not run `mcp-publisher publish` until `/mcp` is reachable at `https://xrp-link.com/mcp` and initialize/tools/list succeed without HTTP 403.
