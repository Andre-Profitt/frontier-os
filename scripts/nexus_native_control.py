#!/usr/bin/env python3
"""Bounded native-control bridge that reuses Nexus macOS primitives.

This script is meant to be executed inside the Nexus uv environment so it can
import ``nexus.jarvis.macos`` without duplicating those implementations inside
frontier-os.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from nexus.jarvis.macos import capture_screen, get_frontmost_app, get_user_context


def _iso_now() -> str:
    return datetime.now(tz=UTC).isoformat()


def _capture_path(artifact_dir: str | None) -> Path | None:
    if not artifact_dir:
        return None
    root = Path(artifact_dir).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(tz=UTC).strftime("%Y%m%dT%H%M%S")
    return root / f"native-control-capture-{stamp}.png"


def _capture_screen_via_quartz(filepath: str | None = None) -> Path:
    from AppKit import NSBitmapImageRep, NSPNGFileType
    from Quartz import (  # pyobjc-framework-Quartz
        CGWindowListCreateImage,
        CGRectInfinite,
        kCGNullWindowID,
        kCGWindowImageDefault,
        kCGWindowListOptionOnScreenOnly,
    )

    target = Path(filepath) if filepath else Path(tempfile.mktemp(suffix=".png"))
    image = CGWindowListCreateImage(
        CGRectInfinite,
        kCGWindowListOptionOnScreenOnly,
        kCGNullWindowID,
        kCGWindowImageDefault,
    )
    if image is None:
        raise RuntimeError("Quartz returned no screen image")
    rep = NSBitmapImageRep.alloc().initWithCGImage_(image)
    if rep is None:
        raise RuntimeError("Quartz could not create a bitmap representation")
    data = rep.representationUsingType_properties_(NSPNGFileType, None)
    if data is None or not data.writeToFile_atomically_(str(target), True):
        raise RuntimeError(f"Quartz could not write capture to {target}")
    return target


def _context_payload() -> dict[str, Any]:
    try:
        context = get_user_context()
    except Exception as exc:  # noqa: BLE001 - context collection is best-effort.
        return {
            "app_name": None,
            "bundle_id": None,
            "window_title": None,
            "project_dir": None,
            "error": str(exc),
        }
    return {
        "app_name": context.app_name,
        "bundle_id": context.bundle_id,
        "window_title": context.window_title,
        "project_dir": context.project_dir,
    }


def _focus_target(
    target_app_name: str | None,
    target_bundle_id: str | None,
) -> dict[str, Any]:
    if target_bundle_id:
        subprocess.run(["open", "-b", target_bundle_id], check=True, timeout=5)
        activation_method = "open_bundle_id"
    elif target_app_name:
        subprocess.run(["open", "-a", target_app_name], check=True, timeout=5)
        activation_method = "open_app"
    else:
        raise RuntimeError("target app focus requested without app name or bundle id")
    deadline = time.monotonic() + 5.0
    last_app_name = None
    last_bundle_id = None
    normalized_target_name = target_app_name.casefold() if target_app_name else None
    while time.monotonic() < deadline:
        app_name, bundle_id = get_frontmost_app()
        last_app_name = app_name
        last_bundle_id = bundle_id
        bundle_matches = bool(target_bundle_id and bundle_id == target_bundle_id)
        name_matches = bool(
            normalized_target_name and app_name and app_name.casefold() == normalized_target_name
        )
        if bundle_matches or name_matches:
            return {
                "requested_app_name": target_app_name,
                "requested_bundle_id": target_bundle_id,
                "frontmost_app_name": app_name,
                "frontmost_bundle_id": bundle_id,
                "matched": True,
                "method": activation_method,
            }
        time.sleep(0.1)
    raise RuntimeError(
        "target app did not become frontmost: "
        f"requested_app={target_app_name!r}, requested_bundle_id={target_bundle_id!r}, "
        f"frontmost={last_app_name!r}, bundle_id={last_bundle_id!r}"
    )


def _run_checked_applescript(script: str) -> str:
    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(detail or f"osascript exited {result.returncode}")
    return result.stdout.strip()


def _type_text_via_cgevent(text: str) -> None:
    from Quartz import (  # pyobjc-framework-Quartz
        CGEventCreateKeyboardEvent,
        CGEventKeyboardSetUnicodeString,
        CGEventPost,
        kCGSessionEventTap,
    )

    key_down = CGEventCreateKeyboardEvent(None, 0, True)
    key_up = CGEventCreateKeyboardEvent(None, 0, False)
    if key_down is None or key_up is None:
        raise RuntimeError("Quartz could not create a keyboard event")

    CGEventKeyboardSetUnicodeString(key_down, len(text), text)
    CGEventKeyboardSetUnicodeString(key_up, len(text), text)
    CGEventPost(kCGSessionEventTap, key_down)
    CGEventPost(kCGSessionEventTap, key_up)


def _type_text_via_applescript(text: str) -> None:
    # Nexus's helper suppresses AppleScript failures; Frontier needs a real
    # success/failure signal for class-2 host control.
    escaped = text.replace("\\", "\\\\").replace('"', '\\"')
    _run_checked_applescript(
        'tell application "System Events"\n'
        f'    keystroke "{escaped}"\n'
        "end tell"
    )


def _type_text_checked(text: str) -> str:
    try:
        _type_text_via_cgevent(text)
        return "cgevent"
    except Exception as cg_error:  # noqa: BLE001 - surface exact fallback reason.
        try:
            _type_text_via_applescript(text)
            return "applescript"
        except Exception as apple_error:  # noqa: BLE001 - preserve both failures.
            raise RuntimeError(
                f"CGEvent failed: {cg_error}; AppleScript failed: {apple_error}"
            ) from apple_error


def run_type_text(args: argparse.Namespace) -> dict[str, Any]:
    text = args.text
    if not text.strip():
        raise ValueError("--text is required")
    target_app_name = args.target_app_name.strip() if args.target_app_name else None
    target_bundle_id = args.target_bundle_id.strip() if args.target_bundle_id else None

    before = _context_payload()
    focused = None
    if target_app_name or target_bundle_id:
        focus_result = _focus_target(target_app_name, target_bundle_id)
        focused = {
            **_context_payload(),
            "focus": focus_result,
        }
    typing_method = _type_text_checked(text)

    capture_file = None
    capture_error = None
    capture_method = None
    if args.capture_after:
        requested_path = _capture_path(args.artifact_dir)
        try:
            # Give the target app a beat to reflect the typed input before capture.
            time.sleep(0.35)
            capture_file = capture_screen(
                str(requested_path) if requested_path is not None else None
            )
            capture_method = "screencapture"
        except Exception as exc:  # noqa: BLE001 - capture is best-effort.
            try:
                capture_file = _capture_screen_via_quartz(
                    str(requested_path) if requested_path is not None else None
                )
                capture_method = "quartz"
            except Exception as quartz_exc:  # noqa: BLE001 - preserve both paths.
                capture_error = (
                    f"screencapture failed: {exc}; quartz fallback failed: {quartz_exc}"
                )

    after = _context_payload()
    return {
        "ok": True,
        "action": "type_text",
        "typing_method": typing_method,
        "requested_at": _iso_now(),
        "typed_characters": len(text),
        "target_app_name": target_app_name,
        "target_bundle_id": target_bundle_id,
        "focused": focused,
        "capture_after": bool(args.capture_after),
        "capture_method": capture_method,
        "capture_path": str(capture_file) if capture_file is not None else None,
        "capture_exists": capture_file.exists() if capture_file is not None else False,
        "capture_error": capture_error,
        "before": before,
        "after": after,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Reuse Nexus macOS helpers for bounded native control."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    type_text_parser = subparsers.add_parser(
        "type-text",
        help="Type text into the frontmost macOS application and optionally capture the result.",
    )
    type_text_parser.add_argument("--text", required=True, help="Text to type.")
    type_text_parser.add_argument(
        "--target-app-name",
        help="Optional macOS app name to activate before typing.",
    )
    type_text_parser.add_argument(
        "--target-bundle-id",
        help="Optional macOS bundle identifier to activate before typing.",
    )
    type_text_parser.add_argument(
        "--capture-after",
        action="store_true",
        help="Capture a screenshot after typing.",
    )
    type_text_parser.add_argument(
        "--artifact-dir",
        help="Optional command artifact directory for the captured screenshot.",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "type-text":
            result = run_type_text(args)
        else:
            raise ValueError(f"unsupported command: {args.command}")
    except Exception as exc:  # noqa: BLE001 - CLI bridge should stay compact.
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": str(exc),
                    "action": getattr(args, "command", None),
                    "failed_at": _iso_now(),
                }
            )
        )
        return 1

    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
