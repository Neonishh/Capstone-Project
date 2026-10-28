"""
screenshot_capture.py
Module 1 — Screenshot Capture

Responsibility:
  Capture a screenshot from the running Android emulator via Appium,
  save it with a timestamped filename, and return the file path.

  Kept completely independent — no YOLO, no OCR, no LLM.
"""

import os
from datetime import datetime, timezone
from pathlib import Path


def capture_screenshot(driver, output_dir: str, step: int, suffix: str = "") -> str:
    """
    Captures the current screen via Appium and saves it as a PNG.

    Args:
        driver:     Active Appium WebDriver instance
        output_dir: Directory to save screenshots
        step:       Current exploration step number (used in filename)

    Returns:
        Absolute path to the saved screenshot file
    """
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    suffix_part = f"_{suffix}" if suffix else ""
    filename = f"screen_{step:02d}{suffix_part}_{ts}.png"
    filepath = str(Path(output_dir) / filename)

    driver.save_screenshot(filepath)
    print(f"[screenshot_capture] Step {step} → {filepath}")
    return filepath
