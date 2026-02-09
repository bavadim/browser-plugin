# BrowserAgentKit Page Customizer Extension

A minimal MV3 browser extension that injects a chat-driven page customization agent into the current tab. It uses `browseragentkit` to run a tool-using agent that can inspect and safely edit the page DOM, with an in-page UI for prompts, status, and settings.

## What it does
- Adds a toolbar action. Clicking it injects the content script into the active tab.
- Renders a floating “Page Agent” panel (shadow DOM) with chat history, settings, and controls.
- Uses BrowserAgentKit tools (DOM summary, subtree, append/remove, JS run) to apply changes to the current page.
- Stores model settings and chat history in extension local storage.

## Tech
- MV3 extension (manifest in `public/manifest.json`)
- Vite build outputting `background.js` and `content.js` into `dist/`
- `browseragentkit` for agent runtime and UI widgets

## Development

Install deps:
```
npm install
```

Build once:
```
npm run build
```

Watch build:
```
npm run dev
```

Vite outputs extension assets to `dist/`.

## Load the extension
1. Build the project (`npm run build` or `npm run dev`).
2. Open the browser’s extensions page (e.g. `chrome://extensions`).
3. Enable Developer Mode.
4. Click “Load unpacked” and select the `dist/` folder.
5. Pin the extension and click its icon on any page.

## Usage
1. Click the extension icon to open the Page Agent panel.
2. Set **Model base URL**, **Model**, and **API key** in Settings.
3. Enter a prompt describing the page change and press **Send** (or Ctrl/Cmd+Enter).
4. Use **Undo** to revert the last change (up to the last 5 snapshots).

## Notes
- The agent is instructed not to modify or remove the element with id `__bak-root`.
- Settings and chat history are stored in extension local storage.

## License
TBD
