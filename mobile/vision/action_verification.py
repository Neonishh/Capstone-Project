"""Evidence-based check of whether an Android action changed the observed UI."""

from PIL import Image, ImageChops


def _texts(elements):
    return {
        " ".join(str(item.get("text") or "").split()).casefold()
        for item in elements
        if len(" ".join(str(item.get("text") or "").split())) >= 3
    }


def _checkable_states(elements):
    states = {}
    for item in elements:
        if not item.get("checkable"):
            continue
        key = "|".join((
            str(item.get("resource_id") or ""),
            " ".join(str(item.get("text") or "").split()).casefold(),
            str(item.get("bbox") or ""),
        ))
        states[key] = bool(item.get("checked"))
    return states


def _image_change(before_path, after_path, bbox=None, status_bar_fraction=0.04):
    """Compare screenshots while ignoring the status bar; return global/local ratios."""
    with Image.open(before_path) as before_file, Image.open(after_path) as after_file:
        before = before_file.convert("L")
        after = after_file.convert("L")

    if before.size != after.size:
        after = after.resize(before.size)

    top = int(before.height * status_bar_fraction)
    before_body = before.crop((0, top, before.width, before.height)).resize((270, 600))
    after_body = after.crop((0, top, after.width, after.height)).resize((270, 600))
    global_ratio = _changed_pixel_ratio(before_body, after_body)

    local_ratio = 0.0
    if bbox:
        x1, y1, x2, y2 = (float(value) for value in bbox)
        pad_x, pad_y = (x2 - x1) * 0.3, (y2 - y1) * 0.3
        box = (
            max(0, int(x1 - pad_x)), max(0, int(y1 - pad_y)),
            min(before.width, int(x2 + pad_x)), min(before.height, int(y2 + pad_y)),
        )
        if box[2] - box[0] >= 4 and box[3] - box[1] >= 4:
            local_before = before.crop(box)
            local_after = after.crop(box).resize(local_before.size)
            local_ratio = _changed_pixel_ratio(local_before, local_after)

    return global_ratio, local_ratio


def _changed_pixel_ratio(before, after, pixel_threshold=25):
    diff = ImageChops.difference(before, after)
    # Convert mean absolute intensity difference into changed-pixel fraction.
    # Thresholded histogram avoids counting minor antialiasing noise.
    histogram = diff.histogram()
    changed = sum(histogram[pixel_threshold + 1:])
    return changed / max(1, before.width * before.height)


def verify_action(before_path, after_path, before_screen, after_screen,
                  before_elements, after_elements, target_bbox=None,
                  global_threshold=0.015, local_threshold=0.08,
                  activity_before=None, activity_after=None):
    """Return changed flag plus the independent evidence supporting the result."""
    global_ratio, local_ratio = _image_change(before_path, after_path, target_bbox)
    before_text, after_text = _texts(before_elements), _texts(after_elements)
    new_text = sorted(after_text - before_text)
    gone_text = sorted(before_text - after_text)
    before_states = _checkable_states(before_elements)
    after_states = _checkable_states(after_elements)
    changed_states = {
        key: {"before": before_states.get(key), "after": after_states.get(key)}
        for key in before_states.keys() | after_states.keys()
        if before_states.get(key) != after_states.get(key)
    }
    screen_changed = bool(
        after_screen and before_screen and after_screen != "unknown" and before_screen != "unknown" and
        " ".join(str(after_screen).split()).casefold() !=
        " ".join(str(before_screen).split()).casefold()
    )
    activity_changed = bool(
        activity_before and activity_after and activity_before != activity_after
    )

    evidence = []
    if activity_changed:
        evidence.append("activity_changed")
    if screen_changed:
        evidence.append("screen_title_changed")
    if changed_states:
        evidence.append("checkable_state_changed")
    if global_ratio >= global_threshold:
        evidence.append("visual_screen_changed")
    if local_ratio >= local_threshold:
        evidence.append("target_region_changed")
    if new_text or gone_text:
        evidence.append("visible_text_changed")

    return {
        "changed": bool(evidence),
        "evidence": evidence,
        "screen_title_changed": screen_changed,
        "activity_changed": activity_changed,
        "global_visual_change": round(global_ratio, 4),
        "target_region_change": round(local_ratio, 4),
        "new_text": new_text[:12],
        "removed_text": gone_text[:12],
        "checkable_state_changes": changed_states,
    }
