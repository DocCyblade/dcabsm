# Development

DCABSM is TypeScript on Node 24, bundled by esbuild into one JS file. It has no runtime dependencies. The exact Node patch is in `.node-version`, and CI and the bundle target use it.

| Command | What it does |
|---|---|
| `npm ci` | Install the tools |
| `npm run check` | Typecheck, lint, format check and unit tests |
| `npm test` | Unit tests only (Vitest) |
| `npm run build` | Bundle to `dist/dcabsm.js` |
| `npm run format` | Format `src`, `test` and `scripts` with oxfmt |

## Layout

- `src/table.ts`: the one noun → verb table. It drives `help` and routing. To build a command, set its `run`.
- `src/cli.ts`: routing, the root and setup guards, and the lock-and-log wrapper for changing commands.
- `src/context.ts`: the `Context` every command gets. The command runner and the fetcher are the only two seams (spec 13.1); it also carries the architecture, environment and clock.
- `src/real.ts`: the production command runner, fetcher and terminal. `src/main.ts` wires them in.
- `src/errors.ts`, `src/help.ts`, `src/version.ts`: exit codes and error text, the `help` text, and the version and layout number.
- `scripts/build.mjs`: the esbuild bundle; it injects the version from `package.json`.
- `src/host/`: Host-level code. `os.ts` holds the supported OS table (spec 1.4), `checks.ts` the refusals (10.3), `setup.ts` `host setup`, `config.ts` `dcabsm.json`, and `notices.ts` the banner and OS warning every other command prints.
- `src/args.ts`, `src/fsutil.ts`, `src/output.ts`: flag parsing, file and directory helpers, and the step marks.
- `src/paths.ts`: every path hangs off one root. `DCABSM_ROOT` moves it; the default is `/`.
- `src/prompt.ts`, `src/lock.ts`, `src/log.ts`: the helpers every command shares.
- `test/helpers.ts`: a `Context` on a temporary root with a faked runner and fetcher. Tests assert on the files left behind.
