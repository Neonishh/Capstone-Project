"""Launch the same explicit Android activity before exploration and every case."""
import time


def launch_start(driver, package, activity):
    if not activity:
        raise ValueError("An explicit app activity is required for reproducible replay")
    driver.execute_script("mobile: startActivity", {
        "component": f"{package}/{activity}",
        "wait": True,
        "stop": True,
        "intentFlags": "0x10008000",
    })
    time.sleep(1.5)
