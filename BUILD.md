# Build

## Source

```bash
npm ci --no-audit --no-fund
npm test
npm start
```

Node.js 18 or newer. `npm test` does not need Electron, a GPU, or a display.

## Packages

```bash
./scripts/build-linux.sh
```

That runs the unit tests and then `electron-builder` for:

- `dist/*.deb`
- `dist/*.AppImage`
- `dist/*.tar.gz`

Electron's Linux libraries (GTK and so on) come from the system when you run a packaged build. This script does not install them for you.

If electron-builder cannot run in the environment (no network, missing system libraries), the source tree and `scripts/build-linux.sh` are still the supported way to produce those artifacts. See `BUILD_LOG.txt` for what this workspace actually produced.

## User install without root

```bash
./scripts/install-ubuntu.sh
./scripts/uninstall-ubuntu.sh          # keep settings
./scripts/uninstall-ubuntu.sh --purge  # also delete $XDG_DATA_HOME/black-mirror
```

The desktop file is `packaging/black-mirror.desktop`. Autostart is not configured.

## What is not in the archive

- Model weights
- llama.cpp / Ollama / Lemonade binaries (downloaded later, into the data directory, when you click Install)
- `node_modules` (reinstall with `npm ci`)

## Windows

`npm run build:win` is unchanged for people building the Windows package from this tree. It still needs a Windows host or a working electron-builder Windows toolchain.
