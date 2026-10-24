# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Tauri 2 webviews inside a native macOS app (menu bar app, Apple silicon, macOS 15+). The interface is HTML/CSS in WKWebView, but it lives among Mac apps and must respect Mac conventions: traffic lights, ⌘ shortcuts, native menus, Quick Look, drag out, vibrancy where it helps.

## Users

- **Gus Dantas, daily.** Data and analytics lead who dictates in English and Portuguese all day, captures screens for reports and decks, records short screen-and-face videos, and pulls tables off the screen into Excel. Uses it in short bursts between other work; the main window is opened to find, copy or send something, then closed.
- **People who find the repository on GitHub.** Developers and designers browsing ghostavo's open-source work. They install it cold, with no context, and judge it in the first minute.

## Product Purpose

One assistant for the Mac that replaces five small apps: system-wide dictation with a live editor, Cast (screen plus face recording), screenshots, text and tables from the screen, a library of everything captured and dictated, and Mac switches (keep Teams available, stay awake with the lid closed, optional VPN). Success: the job is done in seconds and the app gets out of the way; the library finds anything by name, app, text inside a screenshot or words said.

## Positioning

Everything runs locally and is open source; one menu bar icon instead of a drawer of utilities. Dictation is live and editable while you speak, with a second, more accurate pass at every pause. Captures are searchable by the text Vision read inside them.

## Operating Context

- Lives in the menu bar; most jobs start from a global shortcut (⌃2 Cast, ⌃3 screen, ⌃4 area, ⌃5 window, ⌃6 text, hold ⌥ to dictate), not from the window.
- Floating panels appear over other apps: the dictation editor, the after-capture card (bottom left), the Cast control bar, camera bubble and prompter.
- The main window (Today, Library with filters, Dictations) and a separate Settings window (⌘,).
- Captures are files in ~/Downloads/Ghostbar, shared with the Chrome extension (also named Ghostbar), whose editor and video pages are reused inside the app.

## Capabilities and Constraints

- Tauri 2 (Rust), React 18 + TypeScript + Tailwind 4, Swift for AppKit, ScreenCaptureKit, Vision. Pages shared with the Chrome extension are synced into `src/ext` on every build; app-only styling for them goes in `src/ext-platform/`.
- Orange is reserved for recording (a live state), never decoration.
- Must stay fast and quiet: no onboarding tours, no notifications for their own sake.
- Undecided: merging Gus Meeting into Ghostbar.

## Brand Commitments

- Name **Ghostbar**, by **ghostavo** (Gus Dantas's personal brand, ghostavo.com).
- The mark: a single quarter of a cut avocado (quarter disc anchored at the bottom right of a square), whose stone is an egg-shaped eye. One colour is the primary version; the colour version dresses icons. Never combine quarters, rotate, mirror or outline it. Source: `design/mark/make_mark.py`.
- Palette chosen by Gus: teal claro #50C1B1, laranja claro #EE8A50, papel #F2F5F4, ink #10201F, deep #123F3A.
- **Paper is the official ground.** The app is paper-toned always, regardless of the Mac's dark mode (Gus, 25 Oct 2026). Deep teal is an allowed alternative, not the default.
- Direction Gus chose through rounds of exploration: modernism and its relatives, the azulejo tile, "não tem cara de AI", minimal and clear.
- Voice: plain, specific, short. No em dashes in user-facing text.

## Evidence on Hand

- Brand sheet: https://claude.ai/artifact/1y3zobbZe7nKiJ31DPy2qK (construction, versions, sizes, clear space, lockups, don'ts).
- Mark files: `design/mark/` (SVG, app icon 1024 PNG, tray glyphs).
- The current UI, screenshotted 25 Oct 2026 (dark, card-heavy): the anti-reference for the redesign.

## Product Principles

1. The job first, the window second: anything done from a shortcut never needs the window.
2. One obvious next action per surface; everything else is quiet until wanted.
3. Show the user's own material (captures, words), not chrome about it.
4. Mac-native behaviour beats web habits: keyboard, Quick Look, drag, menus.
5. Honest states: recording, listening, failed and done are always unmistakable.

## Accessibility & Inclusion

Keyboard reachable throughout; text contrast at WCAG AA on paper; motion respects Reduce Motion.
