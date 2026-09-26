"""
explore_vision.py
Architecture B — Full Vision Pipeline with LLM Reasoning

Loop (5 steps):
  Screenshot → YOLO → OCR → Merge → LLM decides action
  → Exploration Controller executes via Appium → repeat

Usage:
  python vision/explore_vision.py
  python vision/explore_vision.py --app-package com.example.app --app-activity .MainActivity

Environment variables:
  LLM_PROVIDER=ollama   (default) | groq | gemini | openai
  OLLAMA_MODEL=llama3.1
  APPIUM_HOST=localhost
  APPIUM_PORT=4723
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.parent / ".env")
except ImportError:
    pass

from vision.screenshot_capture import capture_screenshot
from vision.yolo_detector import detect_ui_components
from vision.ocr_extractor import extract_text
from vision.vision_merger import merge
from vision.llm_reasoner import decide_next_action

MAX_STEPS   = 5
APPIUM_HOST = os.environ.get("APPIUM_HOST", "localhost")
APPIUM_PORT = int(os.environ.get("APPIUM_PORT", 4723))

VISION_DIR      = Path(__file__).parent.parent / "logs" / "vision"
SCREENSHOTS_DIR = VISION_DIR / "screenshots"
JSON_DIR        = VISION_DIR / "json"
MEMORY_LOG_PATH = str(VISION_DIR / "vision_memory_log.json")

DEFAULT_APP_PACKAGE  = "com.android.settings"
DEFAULT_APP_ACTIVITY = ".Settings"


# ── Appium setup ──────────────────────────────────────────────────────────────

def build_driver(app_package: str, app_activity: str):
    from appium import webdriver
    from appium.options.android import UiAutomator2Options

    options = UiAutomator2Options()
    options.platform_name          = "Android"
    options.app_package            = app_package
    options.app_activity           = app_activity
    options.no_reset               = True
    options.auto_grant_permissions = True
    options.new_command_timeout    = 300
    options.app_wait_activity      = "*"

    appium_url = f"http://{APPIUM_HOST}:{APPIUM_PORT}"
    print(f"[explore_vision] Connecting to Appium at {appium_url}...")
    driver = webdriver.Remote(appium_url, options=options)
    print("[explore_vision] Connected.")
    return driver


# ── Exploration Controller ────────────────────────────────────────────────────

def _get_screenshot_size(path: str):
    """Returns (width, height) of a screenshot, or (None, None) on failure."""
    try:
        from PIL import Image
        with Image.open(path) as img:
            return img.size  # (width, height)
    except Exception:
        return None, None


def execute_action(driver, action: dict) -> None:
    """
    Receives the LLM's action decision and executes it on the device.

    Coordinates from YOLO/OCR are in screenshot pixel space. This function
    scales them to device screen space before tapping, so the tap lands on
    the correct element regardless of screenshot vs screen resolution mismatch.
    """
    action_type = action.get("action", "done")

    if action_type == "done":
        return

    if action_type == "back":
        driver.back()
        time.sleep(0.5)
        return

    if action_type == "swipe":
        _do_swipe(driver)
        return

    bbox = action.get("bbox")
    if bbox is None:
        print("[explore_vision] No bbox resolved — falling back to swipe")
        _do_swipe(driver)
        return

    x1, y1, x2, y2 = bbox
    cx = (x1 + x2) // 2
    cy = (y1 + y2) // 2

    # Scale from screenshot pixel space → device screen space
    screenshot_path = action.get("_screenshot_path", "")
    ss_w, ss_h = _get_screenshot_size(screenshot_path)
    if ss_w and ss_h:
        device_size = driver.get_window_size()
        scale_x = device_size["width"]  / ss_w
        scale_y = device_size["height"] / ss_h
        cx = int(cx * scale_x)
        cy = int(cy * scale_y)

    # Clamp to screen bounds
    device_size = driver.get_window_size()
    cx = max(0, min(cx, device_size["width"]  - 1))
    cy = max(0, min(cy, device_size["height"] - 1))

    print(f"[explore_vision] Tapping ({cx}, {cy})")

    if action_type == "tap":
        driver.tap([(cx, cy)])

    elif action_type == "type":
        driver.tap([(cx, cy)])
        time.sleep(0.3)
        value = action.get("value", "test@example.com")
        driver.execute_script("mobile: type", {"text": value})


def _do_swipe(driver) -> None:
    size = driver.get_window_size()
    w, h = size["width"], size["height"]
    driver.swipe(
        start_x=w // 2, start_y=int(h * 0.7),
        end_x=w // 2,   end_y=int(h * 0.3),
        duration=500,
    )


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Vision Pipeline — Architecture B")
    parser.add_argument("--app-package",  default=DEFAULT_APP_PACKAGE)
    parser.add_argument("--app-activity", default=DEFAULT_APP_ACTIVITY)
    args = parser.parse_args()

    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    JSON_DIR.mkdir(parents=True, exist_ok=True)

    print("=" * 55)
    print(" Architecture B — Vision Pipeline (PES University 101)")
    print(f"  App      : {args.app_package}/{args.app_activity}")
    print(f"  Steps    : {MAX_STEPS}")
    print(f"  Provider : {os.environ.get('LLM_PROVIDER', 'ollama')}")
    print("=" * 55)

    driver = build_driver(args.app_package, args.app_activity)
    time.sleep(2)

    exploration_history = []   # grows with each step — passed to LLM each time

    try:
        for step in range(1, MAX_STEPS + 1):
            print(f"\n======== Vision Step {step} / {MAX_STEPS} ========")

            # ── Module 1: Screenshot ──────────────────────────────────────
            screenshot_path = capture_screenshot(driver, str(SCREENSHOTS_DIR), step)

            # ── Module 2: YOLO ────────────────────────────────────────────
            try:
                yolo_results = detect_ui_components(screenshot_path)
            except Exception as e:
                print(f"[explore_vision] YOLO failed: {e}")
                yolo_results = []

            # ── Module 3: OCR ─────────────────────────────────────────────
            try:
                ocr_results = extract_text(screenshot_path)
            except Exception as e:
                print(f"[explore_vision] OCR failed: {e}")
                ocr_results = []

            # ── Module 4: Merge ───────────────────────────────────────────
            screen_data = merge(
                step=step,
                screenshot_path=screenshot_path,
                yolo_detections=yolo_results,
                ocr_results=ocr_results,
                output_dir=str(JSON_DIR),
            )

            # ── Module 5: LLM decides next action ─────────────────────────
            try:
                action = decide_next_action(screen_data, exploration_history)
            except Exception as e:
                print(f"[explore_vision] LLM failed: {e}")
                action = {"action": "swipe", "target": "", "bbox": None, "value": "", "reason": "llm_error"}

            # If the LLM picked the same target as the last step, force a swipe
            # instead — tapping a non-interactive element repeatedly does nothing
            if len(exploration_history) >= 1:
                last_target = exploration_history[-1].get("target", "")
                if last_target and action.get("target") == last_target:
                    print(
                        f"[explore_vision] LLM repeated target '{last_target}' — "
                        f"forcing swipe to explore new content"
                    )
                    action = {"action": "swipe", "target": "", "bbox": None, "value": "", "reason": "forced: repeated target"}

            # ── Log step to memory ─────────────────────────────────────────
            log_entry = {
                "step":       step,
                "screen":     screen_data.get("screen", "unknown"),
                "screenshot": screenshot_path,
                "action":     action.get("action"),
                "target":     action.get("target", ""),
                "bbox":       action.get("bbox"),
                "value":      action.get("value", ""),
                "reason":     action.get("reason", ""),
                "timestamp":  datetime.now(timezone.utc).isoformat(),
                "elements_detected": len(screen_data.get("elements", [])),
            }
            exploration_history.append(log_entry)
            print(f"[explore_vision] Logged step {step}")

            # ── Stop if LLM says done ──────────────────────────────────────
            if action.get("action") == "done":
                print("[explore_vision] LLM returned 'done' — stopping early")
                break

            # ── Exploration Controller executes action ─────────────────────
            if step < MAX_STEPS:
                try:
                    action["_screenshot_path"] = screenshot_path
                    execute_action(driver, action)
                    time.sleep(1.5)   # let screen settle
                except Exception as e:
                    print(f"[explore_vision] Execute failed: {e} — continuing")

    except Exception as fatal:
        print(f"\n[explore_vision] FATAL: {fatal}")
        import traceback
        traceback.print_exc()

    finally:
        # Save memory log
        VISION_DIR.mkdir(parents=True, exist_ok=True)
        with open(MEMORY_LOG_PATH, "w", encoding="utf-8") as f:
            json.dump(exploration_history, f, indent=2)
        print(f"\n[explore_vision] Memory log saved → {MEMORY_LOG_PATH}")

        driver.quit()
        print("[explore_vision] Done.")
        print(f"  Screenshots : {SCREENSHOTS_DIR}/")
        print(f"  JSON files  : {JSON_DIR}/")
        print(f"  Memory log  : {MEMORY_LOG_PATH}")


if __name__ == "__main__":
    main()
