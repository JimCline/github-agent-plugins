# github-agent-plugins

This project and its plugin have moved to **[agentic-tool-labs/agent-tools](https://github.com/agentic-tool-labs/agent-tools)**. This repository is archived and no longer updated.

## Switching an existing install

In Claude Code, uninstall the plugin from the old marketplace, remove it, and install the plugin from the new one:

```
/plugin uninstall github-pr-toolkit@jimcline
/plugin marketplace remove jimcline

/plugin marketplace add agentic-tool-labs/agent-tools
/plugin install github-pr-toolkit@agent-tools
```

If you already switched to `JimCline/agent-tools`, follow the steps at [JimCline/agent-tools](https://github.com/JimCline/agent-tools) instead.
