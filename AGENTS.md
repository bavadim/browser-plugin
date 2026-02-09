# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains extension runtime code.
  - `src/background.js` wires the toolbar action to inject the content script.
  - `src/content.js` renders the in-page UI and runs BrowserAgentKit tools.
- `public/manifest.json` is the MV3 manifest copied into `dist/` by Vite.
- `scripts/` holds dev tooling (e.g., `scripts/dev.js`).
- `dist/` is build output (generated; not committed).

## Build, Test, and Development Commands
- `npm run dev` builds in watch mode and launches Chrome with the extension loaded, opening the target URL.
- `npm run build` creates a production build into `dist/`.
- `npm run lint` currently prints a placeholder message (no lint configured).

Example (macOS/Linux):
```bash
CHROME_PATH=/path/to/chrome npm run dev
```

## Coding Style & Naming Conventions
- JavaScript is ESM (`"type": "module"` in `package.json`).
- Use 2-space indentation and semicolons.
- Prefer double quotes for strings, consistent with existing files.
- Keep filenames descriptive and aligned with MV3 roles (`background.js`, `content.js`).

## Testing Guidelines
- No automated tests are configured yet.
- If you add tests, document the framework and add a `npm run test` script in `package.json`.

## Commit & Pull Request Guidelines
- Commit messages are short and imperative (e.g., `"Add dev launcher to open Chrome with extension"`).
- PRs should include:
  - A concise summary of the change.
  - Steps to verify (commands and expected outcome).
  - Screenshots or short clips if UI behavior changes.

## Security & Configuration Tips
- API keys are entered in the in-page UI and stored in extension local storage; do not commit keys.
- Use `CHROME_PATH` if Chrome/Chromium is not on PATH.
