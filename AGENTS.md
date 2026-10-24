# AGENTS.md

Guidance for AI coding assistants working in this repository.

## What it is

Gus Assistant is a macOS menu bar app (Tauri 2: Rust + React/TypeScript, with Swift for the
parts that need AppKit, ScreenCaptureKit and Vision). Apple silicon, macOS 15 or later.

## Commands

```bash
bun install
bun run tauri dev                 # run it
bun run tauri build               # build the .app
./scripts/install-mac.sh          # build, sign ad hoc, install in /Applications, relaunch
./scripts/install-mac.sh --skip-build

cd src-tauri && cargo test --release --lib   # Rust tests (some are #[ignore], run on demand)
npx tsc --noEmit -p .                         # type check the frontend
```

`bun run dev` and `bun run build` first run `scripts/sync-extension.mjs`, which copies the
pages shared with the Chrome extension into `src/ext` from `GUS_EXTENSION_DIR` (default
`~/Projects/gus-screenshot`) and keeps the committed copy when the extension isn't there.
App-only changes to those pages go in `src/ext-platform/` (`store.js`, `ui-brand.css`), never in
`src/ext` directly, or the next sync overwrites them.

## Layout

`src-tauri/src/`
- `lib.rs` - setup, tray and menu events, command registration
- `actions.rs` - what each shortcut does; `shortcut/` - shortcut registration
- `managers/` - audio, models, transcription (live streaming + batch), history
- `dictation.rs` - the live editor panel; `refine.rs` - the second, more accurate pass;
  `proofread.rs` - Claude or Apple Intelligence proofreading
- `cast.rs` + `swift/cast_engine.swift` - screen and face recording
- `capture.rs`, `capture_card.rs`, `capture_meta.rs` - screenshots, the corner card, origin and
  text of each capture; `text_grab.rs` + `swift/text_grab.swift` - text and tables from the screen
- `mac_tools.rs` + `swift/mac_tools.swift` - keep Teams available, awake with the lid closed
- `vpn.rs` - the optional VPN (config in the app data folder, see docs/vpn.md)
- `bridge.rs` - Chrome native messaging host and the local socket
- `tray.rs` - the menu bar menu; `shell.rs` - windows (main, Settings, editor, video)

`src/`
- `App.tsx`, `components/Shell.tsx` - the main window (sidebar, toolbar, pages)
- `components/home/` - Today, Library, Dictations, Mac switches
- `components/SettingsWindow.tsx`, `settings/` - the Settings window (⌘,)
- `dictation/`, `card/`, `capture/` - the floating panels
- `styles/theme.css`, `styles/gus.css` - the ghostavo.com palette and the app's styles

Swift files are compiled into one static library by `src-tauri/build.rs` (`-wmo`); panels that
build AppKit windows must do it on the main thread.

## Conventions

- macOS only. Windows and Linux code paths that remain are unused.
- Plain, specific comments that say why. No em dashes in user-facing text.
- Orange is reserved for recording; teal is the accent (the selection and the one main action).
