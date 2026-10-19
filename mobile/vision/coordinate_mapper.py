"""Map screenshot pixels to Appium tap coordinates and annotate intended taps."""

import os
from pathlib import Path

from PIL import Image, ImageDraw


def _tap_space_size(driver):
    """Prefer display dimensions; fall back to Appium's window dimensions."""
    try:
        info = driver.execute_script("mobile: deviceScreenInfo") or {}
        size = info.get("displaySize") or {}
        if size.get("width") and size.get("height"):
            return int(size["width"]), int(size["height"]), "deviceScreenInfo"
    except Exception:
        pass

    # Android screenshots and W3C pointer actions use full-display pixels.
    # get_window_size can exclude system bars, so it must not scale the image.
    return None


def map_bbox_center(driver, screenshot_path, bbox):
    """Return screenshot center, mapped device point, and geometry diagnostics."""
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        raise ValueError("Target bbox must contain [x1, y1, x2, y2]")

    x1, y1, x2, y2 = (float(value) for value in bbox)
    if x2 <= x1 or y2 <= y1:
        raise ValueError(f"Invalid target bbox: {bbox}")

    with Image.open(screenshot_path) as screenshot:
        shot_w, shot_h = screenshot.size

    dev_w, dev_h, dimensions_source = _tap_space_size(driver) or (shot_w, shot_h, "screenshotPixels")
    scale_x, scale_y = dev_w / shot_w, dev_h / shot_h
    offset_x = int(os.environ.get("TAP_X_OFFSET_PX", "0"))
    offset_y = int(os.environ.get("TAP_Y_OFFSET_PX", "0"))

    shot_x, shot_y = (x1 + x2) / 2, (y1 + y2) / 2
    device_x = round(shot_x * scale_x + offset_x)
    device_y = round(shot_y * scale_y + offset_y)
    device_x = max(0, min(dev_w - 1, device_x))
    device_y = max(0, min(dev_h - 1, device_y))
    mismatch = abs((shot_w / shot_h) - (dev_w / dev_h)) > 0.02

    return {
        "screenshot_size": [shot_w, shot_h],
        "tap_space_size": [dev_w, dev_h],
        "dimensions_source": dimensions_source,
        "scale": [round(scale_x, 5), round(scale_y, 5)],
        "aspect_ratio_mismatch": mismatch,
        "offset": [offset_x, offset_y],
        "screenshot_point": [round(shot_x, 1), round(shot_y, 1)],
        "device_point": [device_x, device_y],
    }


def annotate_tap(screenshot_path, bbox, screenshot_point, label, output_path):
    """Save screenshot copy with target bbox (green) and tap point (red)."""
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(screenshot_path) as source:
        image = source.convert("RGB")

    draw = ImageDraw.Draw(image)
    x1, y1, x2, y2 = (int(round(float(value))) for value in bbox)
    draw.rectangle((x1, y1, x2, y2), outline=(0, 190, 0), width=4)
    x, y = (int(round(float(value))) for value in screenshot_point)
    radius = max(10, image.width // 70)
    draw.ellipse((x - radius, y - radius, x + radius, y + radius), outline=(230, 0, 0), width=4)
    draw.line((x - 2 * radius, y, x + 2 * radius, y), fill=(230, 0, 0), width=3)
    draw.line((x, y - 2 * radius, x, y + 2 * radius), fill=(230, 0, 0), width=3)
    draw.text((8, 8), str(label), fill=(230, 0, 0))
    image.save(output_path)
    return str(output_path)
