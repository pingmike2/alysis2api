#!/usr/bin/env python3
"""
alysis-key — store and print Alysis Code gateway keys (slk_...).

Device-flow login without installing the official `alysis` CLI. Every login is
written to its own numbered file, so a new account never overwrites the key of
an older one:

    alysis-key url        # login -> ~/.config/alysis-code/key1.txt
    alysis-key url        # next login -> key2.txt, key3.txt, ... (never overwrites)
    alysis-key key        # print the newest key
    alysis-key key 2      # print key2
    alysis-key list       # list stored keys
    alysis-key revoke 2   # revoke key2 on the server + delete the local file

Notes (reverse-engineered + verified live):
  - `slk_` keys are LONG-LIVED: no expiry. Access ends only when revoked.
  - What is metered is ACCOUNT CREDIT: 50 free credits refilled every 30 days
    from the last refill; unused credits expire (no carry-over).
    Burst limits: max 10 credits / 5 hours, 25 credits / 7 days.
  - Remaining credit is only visible at https://alysiscode.com/account
    (the gateway has no status endpoint).

Stdlib only. Python 3.10+.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

__version__ = "2.0.0"

SUPABASE_URL = "https://vzigujbcjjmpntxhmyvr.supabase.co"
SITE_URL = "https://alysiscode.com"

# Public anon key — not a secret, it ships bundled with their website.
ANON_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6aWd1amJjamptcG50eGhteXZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5Mzc0NTIsImV4cCI6MjA5NjUxMzQ1Mn0."
    "vLH9q-BNO8IWIZrVlvCw8pZWXdLgmKG4Tl9toTTD3pg"
)

DEVICE_CODE_URL = f"{SUPABASE_URL}/functions/v1/device-code"
DEVICE_TOKEN_URL = f"{SUPABASE_URL}/functions/v1/device-token"
GATEWAY_BASE = f"{SUPABASE_URL}/functions/v1/llm/v1"
REVOKE_URL = f"{GATEWAY_BASE}/logout"
ACCOUNT_URL = f"{SITE_URL}/account"

KEY_DIR = Path(
    os.environ.get("ALYSIS_KEY_DIR") or Path.home() / ".config" / "alysis-code"
)
KEY_RE = re.compile(r"^key(\d+)\.txt$")

HTTP_TIMEOUT_S = 15.0


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------
def post_json(url: str, payload: dict) -> dict:
    headers = {
        "Content-Type": "application/json",
        "apikey": ANON_KEY,
        "Authorization": f"Bearer {ANON_KEY}",
    }
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
            body = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            parsed = json.loads(exc.read().decode())
            err = parsed.get("error", parsed)
            detail = err.get("message", "") if isinstance(err, dict) else str(err)
        except Exception:
            pass
        raise RuntimeError(f"HTTP {exc.code}: {detail or exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Connection failed: {exc.reason}") from exc
    if not isinstance(body, dict):
        raise RuntimeError("Response is not a JSON object")
    return body


def request_device_code() -> dict:
    client_name = f"alysis-key @ {platform.node() or 'unknown'}"[:80]
    body = post_json(DEVICE_CODE_URL, {"client_name": client_name})
    device_code = str(body.get("device_code") or "").strip()
    user_code = str(body.get("user_code") or "").strip()
    if not device_code or not user_code:
        raise RuntimeError(f"Incomplete response: {body}")
    return {
        "device_code": device_code,
        "user_code": user_code,
        # `or <default>` guards against the key being present but null.
        "interval": max(float(body.get("interval") or 5), 1.0),
        "expires_in": max(float(body.get("expires_in") or 900), 1.0),
    }


def poll_for_key(device_code: str, interval: float, expires_in: float) -> str:
    deadline = time.monotonic() + expires_in
    waiting_line = False
    while True:
        try:
            body = post_json(DEVICE_TOKEN_URL, {"device_code": device_code})
        except RuntimeError as exc:
            # Tolerate transient network errors while there is still time
            # left; a single WiFi/DNS blip should not kill a 15-min wait.
            remaining = deadline - time.monotonic()
            if remaining <= 1:
                raise
            print(f"    [polling] transient error, retrying: {exc}", file=sys.stderr)
            time.sleep(min(interval, remaining))
            continue

        status = str(body.get("status") or "").strip().lower()

        if status == "approved":
            if waiting_line:
                print()
            key = str(body.get("key") or "").strip()
            if not key:
                raise RuntimeError("Approved but the key is empty")
            return key
        if status == "denied":
            raise RuntimeError("Login was denied on the website")
        if status in ("expired", "not_found", "already_claimed"):
            raise RuntimeError(f"Code expired / already used ({status})")
        if status == "slow_down":
            # Back off before the server starts blocking us.
            interval = min(interval + 5.0, 30.0)
            continue

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("Timed out waiting for approval (15 minutes)")
        if not waiting_line:
            print("  waiting for approval in the browser...", end="", flush=True)
            waiting_line = True
        else:
            print(".", end="", flush=True)
        time.sleep(min(interval, remaining))


# ---------------------------------------------------------------------------
# Key storage — one numbered file per key, never overwritten
# ---------------------------------------------------------------------------
def stored_keys() -> list[tuple[int, Path]]:
    """All keyN.txt files, sorted by number."""
    if not KEY_DIR.is_dir():
        return []
    found: list[tuple[int, Path]] = []
    try:
        for path in KEY_DIR.iterdir():
            match = KEY_RE.match(path.name)
            if match and path.is_file():
                found.append((int(match.group(1)), path))
    except OSError:
        return []
    return sorted(found)


def find_duplicate(key: str) -> Path | None:
    """Return the existing file that already holds this exact key, if any."""
    for _index, path in stored_keys():
        try:
            if path.read_text().strip() == key:
                return path
        except OSError:
            continue
    return None


def save_new_key(key: str) -> tuple[Path, bool]:
    """Write the key to the next free keyN.txt.

    Returns (path, created). created=False when an identical key is already
    stored — nothing is written, so existing files are never touched.
    """
    duplicate = find_duplicate(key)
    if duplicate is not None:
        return duplicate, False

    KEY_DIR.mkdir(parents=True, exist_ok=True)
    KEY_DIR.chmod(0o700)

    index = stored_keys()[-1][0] + 1 if stored_keys() else 1
    while True:
        path = KEY_DIR / f"key{index}.txt"
        try:
            # O_EXCL: if the file appeared meanwhile, move to the next number
            # instead of overwriting it.
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            index += 1
            continue
        with os.fdopen(fd, "w") as handle:
            handle.write(key + "\n")
        path.chmod(0o600)
        return path, True


def read_key(index: int) -> str | None:
    path = KEY_DIR / f"key{index}.txt"
    try:
        return path.read_text().strip() or None
    except OSError:
        return None


def latest_index() -> int | None:
    keys = stored_keys()
    return keys[-1][0] if keys else None


def preview(key: str) -> str:
    return f"{key[:12]}...{key[-4:]}" if len(key) > 20 else key


def legacy_files() -> list[Path]:
    """Old .txt files in the key dir that are not managed (keyN.txt)."""
    if not KEY_DIR.is_dir():
        return []
    try:
        return sorted(
            p for p in KEY_DIR.iterdir() if p.is_file() and p.suffix == ".txt" and not KEY_RE.match(p.name)
        )
    except OSError:
        return []


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
def cmd_url(args: argparse.Namespace) -> int:
    print("=" * 62)
    print("  Alysis Code — device login")
    print("=" * 62)

    grant = request_device_code()
    activate_url = f"{SITE_URL}/activate?code={grant['user_code']}"

    print(f"\n  Code : {grant['user_code']}")
    print(f"  Link : {activate_url}\n")
    print("  Open the link, log in, then approve.\n")

    if args.open_browser:
        try:
            webbrowser.open(activate_url)
            print("  (opening the link in your browser...)")
        except Exception:
            print("  (could not open a browser — use the link above)")
    else:
        print("  (open the link above yourself; pass --open to launch a browser)")

    key = poll_for_key(grant["device_code"], grant["interval"], grant["expires_in"])

    path, created = save_new_key(key)
    if created:
        print("\n  Approved. Key saved.\n")
        print(f"  File    : {path}")
    else:
        print("\n  Approved. This key is ALREADY stored — nothing written.\n")
        print(f"  File    : {path}")

    print(f"  Preview : {preview(key)}  ({len(key)} chars, mode 600)")
    print("\n" + "=" * 62)
    print("  Use it:")
    print("    export ALYSIS_API_KEY=$(alysis-key key)")
    print(f"    base_url: {GATEWAY_BASE}")
    print(f"  Remaining credit: {ACCOUNT_URL}")
    print("=" * 62)
    return 0


def cmd_key(args: argparse.Namespace) -> int:
    if args.all:
        keys = stored_keys()
        if not keys:
            print(f"No keys stored in {KEY_DIR}", file=sys.stderr)
            print("Run: alysis-key url", file=sys.stderr)
            return 1
        for index, path in keys:
            try:
                print(f"key{index}\t{path.read_text().strip()}")
            except OSError as exc:
                print(f"key{index}\t<unreadable: {exc}>", file=sys.stderr)
        return 0

    index = args.index if args.index is not None else latest_index()
    if index is None:
        print(f"No keys stored in {KEY_DIR}", file=sys.stderr)
        print("Run: alysis-key url", file=sys.stderr)
        return 1

    key = read_key(index)
    if not key:
        print(f"key{index}.txt not found in {KEY_DIR}", file=sys.stderr)
        print("Run: alysis-key list", file=sys.stderr)
        return 1

    # Bare output — safe for $(alysis-key key) / $(alysis-key key 2).
    print(key)
    return 0


def cmd_list(_args: argparse.Namespace) -> int:
    keys = stored_keys()
    if not keys:
        print(f"  no keys yet in {KEY_DIR}")
        print("  run: alysis-key url")
    else:
        print()
        print(f"  {'NAME':<10}{'CREATED':<18}{'PREVIEW':<28}FILE")
        print("  " + "-" * 78)
        for index, path in keys:
            try:
                key = path.read_text().strip()
                when = time.strftime("%Y-%m-%d %H:%M", time.localtime(path.stat().st_mtime))
                print(f"  {'key' + str(index):<10}{when:<18}{preview(key):<28}{path}")
            except OSError as exc:
                print(f"  {'key' + str(index):<10}{'-':<18}{'<unreadable>':<28}{exc}")
        print(f"\n  total {len(keys)} key(s) in {KEY_DIR}")

    legacy = legacy_files()
    if legacy:
        names = ", ".join(p.name for p in legacy)
        print(f"\n  (not managed by alysis-key, left untouched: {names})")
    return 0


def cmd_revoke(args: argparse.Namespace) -> int:
    index = args.index if args.index is not None else latest_index()
    if index is None:
        print(f"No keys stored in {KEY_DIR}", file=sys.stderr)
        return 1

    path = KEY_DIR / f"key{index}.txt"
    key = read_key(index)
    if not key:
        print(f"key{index}.txt not found in {KEY_DIR}", file=sys.stderr)
        return 1

    if not args.yes:
        if not sys.stdin.isatty():
            print("Refusing to delete without confirmation. Re-run with --yes.", file=sys.stderr)
            return 1
        print(f"Revoke key{index} ({preview(key)}) on the server and delete {path}?")
        if input("Type 'yes' to continue: ").strip().lower() != "yes":
            print("Cancelled.")
            return 1

    try:
        req = urllib.request.Request(
            REVOKE_URL,
            data=b"{}",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S).close()
        print("Key revoked on the server.")
    except Exception as exc:
        print(f"Server-side revoke failed (best-effort): {exc}")

    try:
        path.unlink()
    except OSError as exc:
        print(f"Could not delete {path}: {exc}", file=sys.stderr)
        return 1
    print(f"Local key deleted: {path}")
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="alysis-key",
        description="Store and print Alysis Code gateway keys (slk_...).",
        epilog=(
            "Every login is saved to the next free numbered file (key1.txt, "
            "key2.txt, ...) so keys are never overwritten. Files live in "
            f"{KEY_DIR} with mode 600."
        ),
    )
    parser.add_argument("--version", action="version", version=f"alysis-key {__version__}")

    sub = parser.add_subparsers(dest="command")

    url = sub.add_parser("url", help="start device login and store the key as keyN.txt")
    url.add_argument("--open", dest="open_browser", action="store_true", help="open the approval link in a browser")
    # Kept for compatibility with the old script; opening is off by default now.
    url.add_argument("--no-browser", dest="open_browser", action="store_false", help=argparse.SUPPRESS)

    key = sub.add_parser("key", help="print a stored key (newest by default)")
    key.add_argument("index", nargs="?", type=int, help="key number, e.g. 2 for key2.txt")
    key.add_argument("-a", "--all", action="store_true", help="print every stored key")

    sub.add_parser("list", help="list stored keys")

    revoke = sub.add_parser("revoke", help="revoke a key on the server and delete it locally")
    revoke.add_argument("index", nargs="?", type=int, help="key number (newest by default)")
    revoke.add_argument("-y", "--yes", action="store_true", help="skip the confirmation prompt")

    return parser


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)

    # Legacy flags from the old alysis-login script.
    if argv and argv[0] == "--show":
        argv = ["key", *argv[1:]]
    elif argv and argv[0] == "--revoke":
        argv = ["revoke", *argv[1:]]

    parser = build_parser()
    if not argv:
        parser.print_help()
        return 0

    args = parser.parse_args(argv)
    handlers = {"url": cmd_url, "key": cmd_key, "list": cmd_list, "revoke": cmd_revoke}
    handler = handlers.get(args.command or "")
    if handler is None:
        parser.print_help()
        return 2

    try:
        return handler(args)
    except KeyboardInterrupt:
        print("\nCancelled.")
        return 130
    except Exception as exc:
        print(f"\nERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
