# MCP servers

Every harness session connects to the MCP server of the provider its stage works on. Add your own MCP servers under `mcp_servers` at the top level of `orchestrator/artfct.yaml`. Every harness session then connects to them too. Model calls and the orchestrator agent do not.

```yaml
mcp_servers:
  - name: datadog
    url: https://mcp.datadoghq.com/api/unstable/mcp-server/mcp
    headers:
      DD-API-KEY: ${DATADOG_API_KEY}
  - name: sentry
    command: npx
    args: ["-y", "@sentry/mcp-server"]
    env:
      SENTRY_ACCESS_TOKEN: ${SENTRY_TOKEN}
```

- Give a remote server a `url` and optional `headers`. It speaks HTTP unless you set `type: sse`.
- Give a command server a `command` with optional `args` and `env`. The harness starts it inside the sandbox.
- Use a unique `name` for each server. A provider's name, such as `linear`, is taken.
- Reference a secret as `${NAME}` in any value. Put the secret in the orchestrator's `.dev.vars` and upload it with the command in that file's header. A server that references an unset secret is skipped, and the task log names the server and the secret.
- Use read-only keys with the least privilege the server needs. The coding agent can read every value its MCP servers receive.

The shipped `orchestrator/artfct.yaml` connects every harness session to the Cloudflare API MCP server with `CF_READ_API_TOKEN`. Create that token as an account API token with two permissions: the Workers role Metadata Read-Only at the Workers product scope, and Account Analytics Read. The agent can then read the logs, traces, and metrics of the deployment. It cannot read script source or secrets, and it cannot change anything.
