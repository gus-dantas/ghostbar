---
name: Ghostbar
description: A Mac menu bar assistant on paper, by ghostavo. The azulejo index.
colors:
  paper: "#F2F5F4"
  paper-2: "#E7EDEB"
  paper-3: "#DCE4E1"
  sheet: "#FBFCFC"
  ink: "#10201F"
  ink-2: "#55615F"
  ink-3: "#5F6C6A"
  rule: "rgba(16, 32, 31, .13)"
  rule-strong: "rgba(16, 32, 31, .24)"
  teal: "#50C1B1"
  teal-hover: "#5FC8B9"
  teal-ink: "#1C6B61"
  teal-wash: "#D6EEEA"
  orange: "#EE8A50"
  deep: "#123F3A"
  error: "#B42340"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, sans-serif"
    fontSize: "17px"
    fontWeight: 650
    letterSpacing: "-0.01em"
  heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, sans-serif"
    fontSize: "14px"
    fontWeight: 650
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "IBM Plex Mono, ui-monospace, SF Mono, monospace"
    fontSize: "11px"
    fontWeight: 400
  wordmark:
    fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "13.5px"
    fontWeight: 650
    letterSpacing: "0.01em"
rounded:
  none: "0px"
  thumb: "3px"
  control: "4px"
  panel: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "28px"
  section: "34px"
components:
  key:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    height: "40px"
  key-cast:
    backgroundColor: "{colors.teal}"
    textColor: "{colors.ink}"
  button-primary:
    backgroundColor: "{colors.teal}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "30px"
  button-secondary:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "30px"
  sidebar-item-selected:
    backgroundColor: "{colors.teal-wash}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "28px"
  floating-panel:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
---

## Overview

Ghostbar's windows are a sheet of paper ruled into square modules: an index of the user's own captures and words. The look comes from the GhostAvo identity (design/mark/): modernism and the azulejo tile, one quarter-avocado mark, paper as the official ground. It refuses the dark dashboard of rounded cards, glows and coloured icons it replaced.

Ghostbar is paper-toned always. The windows are pinned light whatever the Mac's appearance (`theme(Light)` on every window), and there is no dark palette.

The window serves what is used most: the Awake and VPN switches, then today's dictations, then captures. Captures are a side job, so their keys are a small strip, not the page.

## Colors

- **Paper** is the ground of every window. **Paper-2** is the sidebar, wells and loading thumbnails; **paper-3** is hover on paper-2. **Sheet** is a raised surface: inputs, floating panels, the inspector's text wells.
- **Ink** sets all type. **Ink-2** is secondary text (5.8:1 on paper), **ink-3** meta text such as times and sizes (4.9:1).
- **Teal** is a field colour with ink on it: the Cast key, primary buttons, a switch that is on, the selection ring. It is never text; teal as text or an icon is **teal-ink** (5.7:1). **Teal-wash** marks a selected row.
- **Orange** is a recording and nothing else: the Cast dot, the Stop button, the dictation listening dot.
- **Rules** are hairlines at 13% ink; **rule-strong** (24%) frames the key strip and outlines controls.

## Typography

The system font (SF Pro) for every word, IBM Plex Mono for numbers, keys, times, counts and sizes, the measurements on the page. Titles 17px at 650, section heads 14px at 650, body 13px. Sentence case everywhere; the only uppercase is the sidebar's single "Library" kicker in mono. The wordmark "ghostbar" is lowercase, wide (`font-stretch: 125%`), beside the one-colour mark at the foot of the sidebar.

## Layout

An 8px rhythm: 28px page gutters, 34px above a section head, 12px below it. The main window is a 216px sidebar on paper-2 and the sheet beside it, with a 52px toolbar ruled off by a hairline. Thumbnails sit flush on an auto-fill grid (minimum 176 to 190px, 18px row gap, 14px column gap) with captions under them. The library's inspector is a 288px column behind a hairline. Lists are ruled, with the time in its own mono column. Below 1000px wide, the switches stack.

## Elevation & Depth

Flat. Hierarchy comes from rules, type and spacing, not boxes. Only things that float over other apps carry a shadow: the dictation editor, the after-capture card and the Cast panel use `0 6–14px 18–40px rgba(16, 32, 31, .16–.22)` plus a hairline. Hover actions on a thumbnail sit on a sheet with a 1px rule and a 1px shadow.

## Shapes

Square corners. 4px on controls (buttons, inputs, segmented controls, sidebar rows), 3px on thumbnails, 6px on floating panels, 0 on the key strip. Switches and the camera bubble are the only round things. The one curve in the identity is the quarter of the mark; never combine quarters, rotate, mirror or outline it.

## Components

- **Key strip:** hairline-joined modules on rule-strong; each shows its shortcut in mono beside its name. The Cast key is the teal one. Hover lifts to sheet, press to paper-2.
- **Switches row:** one ruled line, two columns (☕ Awake, 🌍 VPN), the state in mono under the name, a 30×18 switch on the right. Awake turns both halves on or off: the Mac doesn't sleep (lid closed included) and Teams stays Available.
- **Contact sheet / library tile:** thumbnail with an inset hairline, a paper chip for the format (mono), title 12.5px semibold, meta in mono. Selection is a 2px teal ring offset by 2px of paper.
- **Ruled list row:** time (mono) · text clamped to two lines · meta, hairline beneath, teal-wash when selected.
- **Inspector:** preview in a paper-2 well, key/value pairs, a teal primary action spanning the width, secondary actions outlined.
- **Floating panels:** sheet, 6px corners, hairline, soft ink shadow; text in ink, hints in ink-2.
- **Menu bar menu:** native, short, emoji-led: ☕ Awake, 🌍 VPN, 🎙 Copy last dictation, 🎬 Cast, 📸 Capture (submenu with the shortcuts and recent captures), 🗂 Library, ⚙️ Settings, Quit.

## Do's and Don'ts

- Do let rules and spacing group things; add a box only when its absence confuses.
- Do keep teal as a field with ink on it, and teal-ink for teal text.
- Do show shortcuts in mono wherever an action appears, so the window teaches the keys.
- Don't bring back a dark palette, vibrancy or translucent glass.
- Don't use orange for anything but a live recording.
- Don't use rounded cards, coloured icon tiles, gradients or glows.
- Don't put the mark anywhere as decoration; it signs the sidebar foot and the icons.
