#!/usr/bin/env bash
# CryptMail Android driver — adb + uiautomator + webview DevTools.
#
#   bash .claude/skills/run-cryptmail/driver.sh <command> [args]
#
# Run from app/. Works in Git Bash on Windows (MSYS path conversion is
# disabled below, or `adb shell` paths like /sdcard get mangled).
set -uo pipefail
export MSYS_NO_PATHCONV=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG=app.cryptmail.prototype
SDK="${ANDROID_HOME:-${LOCALAPPDATA:-$HOME}/Android/Sdk}"
ADB="$SDK/platform-tools/adb"
EMULATOR="$SDK/emulator/emulator"
SHOTS="${SHOTS:-${TMP:-/tmp}/cryptmail-shots}"
mkdir -p "$SHOTS"

die() { echo "driver: $*" >&2; exit 1; }

# Dump the UI tree and print one line per node whose text or content-desc
# matches the (case-insensitive, extended) regex:  <cx> <cy> <text>|<desc>
# The regex is applied to each field on its own, so ^ and $ anchor to it.
nodes() {
  "$ADB" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || die "uiautomator dump failed"
  "$ADB" shell cat /sdcard/ui.xml | tr '>' '\n' |
    sed -nE 's/.*text="([^"]*)".*content-desc="([^"]*)".*bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]".*/\3\t\4\t\5\t\6\t\1\t\2/p' |
    awk -F'\t' -v re="$1" 'BEGIN { re = tolower(re) }
      tolower($5) ~ re || tolower($6) ~ re { print int(($1+$3)/2), int(($2+$4)/2), $5 "|" $6 }'
}

# Android's own "isn't responding" dialog blocks every tap under it. The
# emulator raises one for `system` when it is starved — which a tight
# uiautomator poll can cause. Answer it with Wait, never Close.
clear_anr() {
  if nodes "isn't responding" | grep -q .; then
    read -r x y _ < <(nodes "^wait$" | head -1)
    [ -n "${x:-}" ] && "$ADB" shell input tap "$x" "$y" && echo "answered an ANR dialog with Wait" >&2
  fi
}

case "${1:-help}" in
  devices) # list attached devices and available AVDs
    "$ADB" devices; echo "AVDs:"; "$EMULATOR" -list-avds ;;

  boot) # boot [avd]: COLD boot an AVD (default: first listed), killing a running one
    # Cold, always. A Quick Boot snapshot restores whatever state the emulator
    # was saved in — including a starved system_server that ANRs every app —
    # and "booted in 7 seconds" is how that looks.
    avd="${2:-$("$EMULATOR" -list-avds | head -1)}"
    if "$ADB" devices | grep -q '^emulator-'; then "$ADB" emu kill >/dev/null; sleep 5; fi
    ("$EMULATOR" -avd "$avd" -no-snapshot-load >/dev/null 2>&1 &)
    "$ADB" wait-for-device
    until [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; do sleep 2; done
    echo "booted $avd" ;;

  metro) # ensure Metro is serving on 8081 (starts it in watch mode if not)
    if curl -s localhost:8081/status | grep -q running; then echo "metro already running"; exit 0; fi
    (npx expo start --port 8081 >"$SHOTS/metro.log" 2>&1 &)
    for _ in $(seq 1 60); do curl -s localhost:8081/status | grep -q running && { echo "metro up (log: $SHOTS/metro.log)"; exit 0; }; sleep 2; done
    die "metro did not come up; see $SHOTS/metro.log" ;;

  launch) # cold-start the app against Metro and wait for JS to run
    "$ADB" reverse tcp:8081 tcp:8081 >/dev/null
    "$ADB" logcat -c
    "$ADB" shell am force-stop "$PKG"
    "$ADB" shell am start -n "$PKG/.MainActivity" >/dev/null
    # `Running "main"` is logged long before the first frame — the app restores
    # its session behind a black screen for ~10-20s — so wait for real UI: the
    # inbox's Compose button, or the connect screen when nobody is signed in.
    # Poll gently: every dump costs the emulator a few seconds of work.
    sleep 15
    for _ in $(seq 1 15); do
      clear_anr
      if nodes "^compose$|connect|sign in|continue with" | grep -q .; then echo "app ready"; exit 0; fi
      sleep 5
    done
    echo "--- last JS log ---" >&2; "$ADB" logcat -d -s ReactNativeJS:V | tail -10 >&2
    die "no UI in 90s — is Metro up and the debug build installed?" ;;

  shot) # screenshot -> $SHOTS/<name>.png (prints the path)
    out="$SHOTS/${2:-shot}.png"; "$ADB" exec-out screencap -p >"$out"; echo "$out" ;;

  find) # find <regex>: matching nodes as "<x> <y> <text>|<content-desc>"
    nodes "${2:?regex}" ;;

  tapdesc) # tapdesc <regex>: tap the first node whose text/content-desc matches
    read -r x y _ < <(nodes "${2:?regex}" | head -1) || true
    [ -n "${x:-}" ] || die "no node matches /$2/"
    "$ADB" shell input tap "$x" "$y"; echo "tapped $x,$y" ;;

  tap) # tap <x> <y> in device pixels (NOT screenshot-viewer pixels)
    "$ADB" shell input tap "${2:?x}" "${3:?y}" ;;

  type) # type <text>: slowly, word by word, so RN controlled inputs keep up
    # Two R keystrokes inside ~200ms is React Native's dev "reload" chord, and it
    # fires whenever focus is not in a *native* TextInput — which the rich-text
    # editor (a WebView) is not. `adb input text driver` sends both r's fast
    # enough to reload the app, so every r goes out in its own chunk, spaced.
    first=1
    for word in ${2:?text}; do
      [ $first = 1 ] || "$ADB" shell input text "%s"
      first=0
      rest="$word"
      while [ -n "$rest" ]; do
        head="${rest%%[rR]*}"
        if [ "$head" = "$rest" ]; then chunk="$rest"; rest=""
        else chunk="$head${rest:${#head}:1}"; rest="${rest:$((${#head} + 1))}"; fi
        "$ADB" shell input text "$chunk"
        [ -n "$rest" ] && sleep 0.35
      done
      sleep 0.4
    done ;;

  key) # key <keycode>: 66=ENTER 67=DEL 123=MOVE_END 4=BACK
    "$ADB" shell input keyevent "${2:?keycode}" ;;

  clear-anr) # answer a system "isn't responding" dialog with Wait, if one is up
    clear_anr ;;

  dismiss-logbox) # close the dev "Open debugger to view warnings" banner if shown
    if nodes "Open debugger" | grep -q .; then
      read -r _ y _ < <(nodes "Open debugger" | head -1)
      w=$("$ADB" shell wm size | grep -oE '[0-9]+x' | head -1 | tr -d x)
      "$ADB" shell input tap $((w - 94)) "$y"; echo "dismissed"
    else echo "no banner"; fi ;;

  log) # log [n]: last n JS log lines (default 30)
    "$ADB" logcat -d -s ReactNativeJS:V AndroidRuntime:E | tail -"${2:-30}" ;;

  webview) # webview <js-expr>: evaluate inside the app's first WebView (editor / HTML reader)
    pid=$("$ADB" shell pidof "$PKG" | tr -d '\r')
    [ -n "$pid" ] || die "app not running"
    "$ADB" forward tcp:9222 "localabstract:webview_devtools_remote_$pid" >/dev/null
    # MSYS_NO_PATHCONV also stops Git Bash translating this path for Windows
    # node, which would otherwise look for D:\d\Programs\... — translate it here.
    script="$HERE/cdp.mjs"; command -v cygpath >/dev/null && script="$(cygpath -m "$script")"
    node "$script" "${2:?js expression}" ;;

  bundle-has) # bundle-has <string>: does the JS the device last downloaded contain it?
    n=$("$ADB" shell "run-as $PKG grep -c '${2:?string}' files/BridgelessReactNativeDevBundle.js" | tr -d '\r')
    echo "device bundle matches: ${n:-0}"; [ "${n:-0}" != 0 ] ;;

  *)
    sed -n 's/^  \([a-z-]*\)) # \(.*\)/  \1 — \2/p' "$0" ;;
esac
