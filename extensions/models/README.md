Model, thinking, and login, as Pi does them: a model button and a thinking-level button in the composer toolbar, a searchable model picker grouped by provider (availability, login status, context window, thinking, price per million tokens), and a login dialog that drives any pi-ai provider's flow, subscription or API key, with credentials shared with pi in `~/.pi/agent/auth.json`.

Picking a model calls `api.configure({ model })`; the server keeps the thinking level when the model supports it and otherwise clamps it with Pi's `clampThinkingLevel`, and the toolbar shows what it configured. A model whose provider is not logged in opens the login for that provider. The thinking menu offers the model's supported levels (Pi's `getSupportedThinkingLevels`), and Shift+Tab cycles them in Pi's order, like Pi. Commands: `model.pick`, `model.thinking`, `model.thinking.cycle` (Shift+Tab), `auth.login`; the status line's model opens the picker through `model.pick`.

A response that ran on another model or thinking level than the response before it gets a quiet divider above it (`model a → b · thinking high → max`), derived from what each stored response records, so it needs no writes, covers branches and older history, and shows where a change took effect rather than when it was picked. Each response records the thinking level its request asked for (`thinkingLevel`, through this repository's Pi Durable patch); responses from before that compare the level the provider reports (`providerThinkingLevel`), which only some providers do. `switches.ts` derives them.

Login is this extension's own: `server.ts` runs Pi's `modelRuntime.login` behind four actions, `login { provider, type }` → `{ flowId }`, `answer { flowId, value }` (an empty answer is an answer), `cancel { flowId }`, and `logout { provider }`. Each flow is shown in `models.login`, a document on the conversation that started it: status, the pending prompt, and the provider's events, never answers, credentials, or provider error details (a failed flow reads `Login failed`). Flows are process-local; one that dies with its process reads cancelled from the next start on. The dialog streams the document with `useDoc` and renders the events (`auth_url` with open and copy, `device_code` with a countdown, `info`, `progress`) and the `text`, `secret`, `select`, and `manual_code` prompts; closing it or the tab cancels a running flow, as does showing another conversation (the document stays with the one that started the flow), configured providers can log out, and a finished login or logout refreshes the model list with `refreshModels()`, which every tab also calls when its window gains focus, for logins in another tab or in pi.

## Custom API-key providers: CoralBricks

Ultimate uses Pi's custom providers from `~/.pi/agent/models.json`. Model-list requests reload that file with network catalog discovery disabled. After editing it, return focus to Ultimate to refresh the list; no restart is needed. Keep any existing providers when adding a new one.

For [CoralBricks](https://www.coralbricks.ai/docs/pi), add this `coralbricks` entry under `providers`:

```json
{
  "providers": {
    "coralbricks": {
      "name": "CoralBricks",
      "baseUrl": "https://inference.coralbricks.ai/v1",
      "api": "openai-completions",
      "models": [
        {
          "id": "glm-5.3-fast",
          "name": "GLM 5.3",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 1048576,
          "maxTokens": 32768
        },
        {
          "id": "deepseek-v4.1-flash-fast",
          "name": "DeepSeek V4.1 Flash",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 1048576,
          "maxTokens": 32768
        }
      ]
    }
  }
}
```

Open the command palette (Ctrl+K or ⌘K), choose **Pick a model**, search for `coralbricks`, and select a model to open its login dialog. Choose **API key** and enter the key in the secret field. Pi stores the credential in its shared auth store; do not put the key in a chat message or this model configuration. A successful login refreshes model availability. See [CoralBricks documentation](https://www.coralbricks.ai/docs.md) for current model IDs, limits, and prices; this configuration does not set prices.

`picker.tsx` is the model picker (its `ModelRow` also lists models in the conversations extension's Summary model picker), `login.tsx` the login dialog, `state.tsx` the shared helpers (the current model, cycling, dialog ids, which provider the login opens on), `server.ts` the login actions and document.
