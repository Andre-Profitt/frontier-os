const FRONTIER_BIN = "/Users/test/frontier-os/bin/frontier";

export function mcpConfig(agent: "codex" | "claude" | "all" = "all") {
  const base = {
    name: "frontier-os",
    command: FRONTIER_BIN,
    args: ["mcp", "run"],
  };
  const codexToml = `[mcp_servers.frontier-os]
command = "${FRONTIER_BIN}"
args = ["mcp", "run"]
`;
  const claudeJson = {
    mcpServers: {
      "frontier-os": {
        command: FRONTIER_BIN,
        args: ["mcp", "run"],
      },
    },
  };
  return {
    server: base,
    codex:
      agent === "codex" || agent === "all"
        ? {
            target: "~/.codex/config.toml",
            format: "toml",
            snippet: codexToml,
          }
        : null,
    claude:
      agent === "claude" || agent === "all"
        ? {
            target: "~/Library/Application Support/Claude/claude_desktop_config.json",
            format: "json",
            snippet: claudeJson,
          }
        : null,
  };
}
