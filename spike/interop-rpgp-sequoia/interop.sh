#!/usr/bin/env bash
#
# Round-trips a message between cryptmail-core (rPGP) and Sequoia-PGP.
#
# Two processes exchanging armored files, because the two libraries cannot be
# linked into one binary — see README.md. That is also what interop means.
#
#   ./interop.sh
#
# Exits non-zero on the first failure and says which check failed.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

RPGP="$here/rpgp-side/target/debug/rpgp-side"
SEQ="$here/sequoia-side/target/debug/sequoia-side"

# Always build. Skipping this when the binaries merely *exist* means a change
# to `core/` is silently not under test, which cost a confusing debugging round
# the first time it happened.
echo "building both sides (first run takes a few minutes — two separate dependency trees)…"
(cd "$here/rpgp-side" && cargo build --quiet)
(cd "$here/sequoia-side" && cargo build --quiet)

pass=0
fail=0

check() { # check <name> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    echo "  ok    $1"
    pass=$((pass + 1))
  else
    echo "  FAIL  $1"
    echo "        expected: $2"
    echo "        actual:   $3"
    fail=$((fail + 1))
  fi
}

MESSAGE='Hey, are we still on for lunch?'
printf '%s' "$MESSAGE" > "$work/plaintext.txt"

mkdir -p "$work/alice"
"$RPGP" gen "$work/alice" alice@example.com > "$work/alice.asc"
"$SEQ"  gen "$work/bob-secret.asc" bob@example.com > "$work/bob.asc"

echo
echo "1. can a foreign parser read our certificate, and agree what it is?"
# The cheapest check and the one that catches the most: if the algorithm IDs
# disagree, every recipient rejects our key outright.
inspected="$("$SEQ" inspect "$work/alice.asc")"
field() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)" <<< "$inspected"; }
check "sequoia parses a cryptmail-core certificate" "0" "$?"
check "primary is Ed25519"            "Ed25519"          "$(field "['primary']")"
check "primary is a v6 key"           "6"                "$(field "['primaryVersion']")"
check "encryption subkey is ML-KEM-768+X25519" "['MLKEM768_X25519']" "$(field "['encryptionSubkeys']")"

echo
echo "2. we send, they read  — the direction that matters most"
"$RPGP" encrypt "$work/alice" alice@example.com "$work/bob.asc" "$work/plaintext.txt" \
  > "$work/to-bob.asc"
out="$("$SEQ" decrypt "$work/bob-secret.asc" "$work/alice.asc" "$work/to-bob.asc")"
check "sequoia decrypts our message" "$MESSAGE" "$(python3 -c "import json,sys; print(json.load(sys.stdin)['plaintext'])" <<< "$out")"
check "sequoia verifies our signature" "valid" "$(python3 -c "import json,sys; print(json.load(sys.stdin)['signature'])" <<< "$out")"

echo
echo "3. they send, we read"
"$SEQ" encrypt "$work/bob-secret.asc" "$work/alice.asc" "$work/plaintext.txt" \
  > "$work/to-alice.asc"
out="$("$RPGP" decrypt "$work/alice" alice@example.com "$work/bob.asc" "$work/to-alice.asc")"
check "cryptmail-core decrypts a sequoia message" "$MESSAGE" "$(python3 -c "import json,sys; print(json.load(sys.stdin)['plaintext'])" <<< "$out")"
check "cryptmail-core verifies a sequoia signature" "valid" "$(python3 -c "import json,sys; print(json.load(sys.stdin)['signature'])" <<< "$out")"

echo
echo "4. interop must not weaken fail-closed"
# A message encrypted to somebody else must stay unreadable, however well the
# two implementations agree on the format.
"$SEQ" gen "$work/mallory-secret.asc" mallory@example.com > "$work/mallory.asc"
"$SEQ" encrypt "$work/bob-secret.asc" "$work/mallory.asc" "$work/plaintext.txt" \
  > "$work/to-mallory.asc"
if "$RPGP" decrypt "$work/alice" alice@example.com "$work/bob.asc" "$work/to-mallory.asc" \
     > /dev/null 2>&1; then
  check "a message addressed to someone else stays unreadable" "rejected" "decrypted"
else
  check "a message addressed to someone else stays unreadable" "rejected" "rejected"
fi

echo
echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
