---
name: run-cryptmail
description: Run, launch, drive and screenshot the CryptMail app on the Android emulator. Use when asked to test on the emulator, start the app, take a screenshot of a screen, tap through a flow (compose, rich-text editor, inbox, message), inspect the editor/HTML-reader WebView, or check a change actually reached the device.
---

CryptMail is an Expo / React Native app; the agent path is an Android emulator
driven by `.claude/skills/run-cryptmail/driver.sh` — adb for taps, typing and
screenshots, `uiautomator` to find elements by accessibility label, and Chrome
DevTools Protocol (`cdp.mjs`) to evaluate JS inside the app's WebViews (the
rich-text editor and the HTML reader).

All paths are relative to `app/`. Verified on Windows 11 in Git Bash with an
existing debug build installed (`app.cryptmail.prototype`), the AVD
`Pixel_10_Pro_XL`, Node 24, and a signed-in Gmail throwaway account.

## Prerequisites

- Android SDK at `%LOCALAPPDATA%\Android\Sdk` (or `$ANDROID_HOME`) with
  `platform-tools` and `emulator`, and at least one AVD.
- The debug build installed on it. Building it is out of scope here (Gradle,
  `app/android`); the driver only launches what is installed.
- `app/.env` with the OAuth client ids (see `docs/running-it.md`); without it
  the app stops at the connect screen.

## Run (agent path)

```bash
cd app
D=.claude/skills/run-cryptmail/driver.sh
bash $D devices              # attached devices + AVDs
bash $D boot                 # cold-boot the first AVD (~50s); skip if one is healthy
bash $D metro                # reuse Metro on :8081, or start one in watch mode (~60s)
bash $D keyboard             # full on-screen keyboard (else Gboard shows only a pill)
bash $D launch               # force-stop, start, wait for real UI (~35-55s): "app ready"
bash $D dismiss-logbox       # close the dev "Open debugger to view warnings" banner
bash $D shot inbox           # -> $TMP/cryptmail-shots/inbox.png — then READ it
```

Drive by accessibility label, never by guessed coordinates. `find` prints
`<x> <y> <text>|<content-desc>`; `tapdesc` taps the first match. Regexes are
case-insensitive and anchor per field:

```bash
bash $D tapdesc "^compose$"
bash $D type "neotestmail9@gmail.com,"     # a trailing comma commits the chip
bash $D tapdesc "^subject"
bash $D type "Skill check"
bash $D tapdesc "^format text$"            # rich-text toggle; wait ~7s for the editor
bash $D tapdesc "^bold$"
bash $D tap 672 1250                        # tap INSIDE the editor body first (see Gotchas)
bash $D type "driver works for rich text"
bash $D webview 'document.querySelector(".ProseMirror").innerHTML'
#  -> "<p><strong>Driver works for rich text</strong></p>"
bash $D shot compose
```

Clean up a test draft through the app: `key 4` (hide keyboard), then
`tapdesc "^more options$"`, `tapdesc "^discard message$"`, `tapdesc "^discard$"`.

| command | what it does |
|---|---|
| `devices` | adb devices + AVD list |
| `boot [avd]` | kill any running emulator, **cold** boot, wait for `sys.boot_completed` |
| `metro` | ensure Metro serves :8081; log at `$TMP/cryptmail-shots/metro.log` |
| `launch` | `adb reverse` 8081, restart the app, wait for Compose/connect UI (answers ANRs) |
| `shot <name>` | screenshot to `$TMP/cryptmail-shots/<name>.png` |
| `find <re>` / `tapdesc <re>` | locate / tap by text or content-desc |
| `tap <x> <y>` | tap in **device** pixels |
| `type <text>` | type slowly; spaces become `%s`; r's are spaced out |
| `key <code>` | 66 Enter, 67 Del, 123 End, 4 Back |
| `keyboard` | show the full on-screen keyboard despite the host keyboard |
| `clear-anr` | answer an "isn't responding" dialog with Wait |
| `dismiss-logbox` | close the dev warnings banner |
| `log [n]` | last n `ReactNativeJS` lines |
| `webview <js>` | evaluate in the first WebView, print JSON |
| `bundle-has <str>` | does the JS bundle the device last downloaded contain `<str>`? |

## Run (human path)

`npx expo start` in `app/`, then open the installed dev build on the emulator.
Expo Go will not load the native modules.

## Test

```bash
npx tsc --noEmit && npm test -- --ci     # 84 suites, 1514 tests at time of writing
```

## Gotchas

- **Screenshot pixels are not device pixels.** The image viewer downscales
  1344×2992 to 898×2000 — multiply viewer coordinates by 1.5. Better: use
  `find`/`tapdesc`, which read device bounds.
- **`Running "main"` in logcat is not "ready".** The app restores its session
  behind a black screen for 15–50s after it. `launch` waits for the Compose
  button (or the connect screen) instead.
- **Double R reloads the app.** RN dev builds treat two R keystrokes within
  ~200ms as "reload" whenever focus is not in a native TextInput — and the
  rich-text editor is a WebView. `adb shell input text driver` did exactly this
  mid-flow ("Loading from 10.0.2.2:8081…"). `type` sends each r in its own
  spaced chunk.
- **The editor ignores keystrokes until tapped.** After `format text` and the
  Bold button the keyboard is up and Bold is lit, but `input text` goes nowhere.
  Tap inside the editor body (`tap 672 1250` on this AVD, or anywhere in the
  grey box) and then type. Gboard also capitalises the first word.
- **Metro's watcher can silently stop.** Edits stopped reaching the device
  even across app restarts, while `curl localhost:8081/index.bundle…` served the
  new code — the app's entry (`.expo/.virtual-metro-entry.bundle`) came from a
  stale graph. Check with `bundle-has` after an edit; if 0, stop the process on
  :8081 and run `metro` again. Search for **string literals** from your change:
  Babel rewrites `const` to `var`, so `bundle-has "const PM = "` is always 0.
- **Quick Boot can restore a broken emulator.** After hours of use,
  `system_server` hung and ANR'd every app (black screen, "Process system isn't
  responding" behind it). `adb emu kill` + a snapshot boot came back in 7s with
  the same fault. `boot` always passes `-no-snapshot-load`.
- **The emulator hides the real keyboard.** It reports the host keyboard as a
  physical one, so Gboard shows only a floating suggestion pill — which also
  sits on top of whatever is at the bottom of the screen and eats taps there.
  A formatting bar hidden behind the keyboard shipped past that; run `keyboard`
  before checking anything that has to sit above it.
- **Don't poll `uiautomator` tightly.** A dump every 2s on a struggling
  emulator coincided with the system ANRs; `launch` polls every 5s after a 15s
  head start.
- **The WebView DevTools socket exists only once a WebView does.** `webview`
  says "no WebView page" on the inbox; open Compose with formatting on, or a
  message. The socket is `webview_devtools_remote_<pid>`, so it changes on
  every launch — `webview` re-forwards each call.
- **Git Bash path mangling.** `MSYS_NO_PATHCONV=1` is required for
  `adb shell … /sdcard/ui.xml`, and it then also stops Git Bash translating
  script paths for Windows `node` (`Cannot find module 'D:\d\Programs\…'`) —
  `webview` runs the path through `cygpath -m`.
- **The inbox's tiptap warning is noise:** `Duplicate extension names found:
  ['textStyle', 'listItem']` comes from the stock editor bundle.

## Troubleshooting

- **`driver: no UI in 90s`, screenshot all black:** run `bash $D find "responding"`.
  A system ANR → `boot` (cold). A `CryptMail isn't responding` right after a tap
  on a freshly snapshot-booted emulator → also `boot`.
- **Change not visible after relaunch:** `bundle-has "<literal from the diff>"`
  prints 0 → restart Metro as above.
- **`no node matches /…/`:** the screen is not what you think — `shot` and read
  it; a keyboard or sheet may cover the target (`key 4` closes the keyboard).
- **`uiautomator dump failed`:** usually an ANR dialog or a mid-transition
  screen; `clear-anr`, wait a few seconds, retry.
