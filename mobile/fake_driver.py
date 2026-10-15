"""
Fake Appium driver for dry-running explore_mobile.py's logic without a real
device/emulator/Appium server. Simulates a tiny 3-screen app:

  Screen A (MainActivity) -- tap 'Go to Settings' --> Screen B (SettingsActivity)
  Screen B -- tap 'Back' (or driver.back()) --> Screen A

Only implements the subset of the Appium API that explore_mobile.py,
view_hierarchy_parser.py, and llm_client.py actually touch.
"""

SCREEN_A_XML = """<?xml version="1.0"?>
<hierarchy>
  <android.widget.FrameLayout displayed="true">
    <android.widget.TextView text="Welcome" displayed="true" clickable="false" checkable="false" resource-id="" content-desc="" bounds="[0,0][1080,100]" package="com.example.fakeapp" class="android.widget.TextView"/>
    <android.widget.Button text="Go to Settings" displayed="true" clickable="true" checkable="false" resource-id="com.example.fakeapp:id/btn_settings" content-desc="" bounds="[100,200][900,300]" package="com.example.fakeapp" class="android.widget.Button"/>
    <android.widget.EditText text="" displayed="true" clickable="true" checkable="false" resource-id="com.example.fakeapp:id/input_search" content-desc="Search box" bounds="[100,400][900,500]" package="com.example.fakeapp" class="android.widget.EditText"/>
  </android.widget.FrameLayout>
</hierarchy>"""

SCREEN_B_XML = """<?xml version="1.0"?>
<hierarchy>
  <android.widget.FrameLayout displayed="true">
    <android.widget.TextView text="Settings" displayed="true" clickable="false" checkable="false" resource-id="" content-desc="" bounds="[0,0][1080,100]" package="com.example.fakeapp" class="android.widget.TextView"/>
    <android.widget.Switch text="Enable notifications" displayed="true" clickable="true" checkable="true" resource-id="com.example.fakeapp:id/switch_notify" content-desc="" bounds="[100,200][900,300]" package="com.example.fakeapp" class="android.widget.Switch"/>
    <android.widget.Button text="Back" displayed="true" clickable="true" checkable="false" resource-id="com.example.fakeapp:id/btn_back" content-desc="" bounds="[100,400][900,500]" package="com.example.fakeapp" class="android.widget.Button"/>
  </android.widget.FrameLayout>
</hierarchy>"""


class FakeElement:
    def __init__(self, driver, resource_id):
        self.driver = driver
        self.resource_id = resource_id

    def click(self):
        self.driver._handle_click(self.resource_id)

    def clear(self):
        pass

    def send_keys(self, value):
        print(f"  [FakeElement] typed '{value}' into {self.resource_id}")


class FakeDriver:
    """Minimal stand-in for appium.webdriver.Remote."""

    def __init__(self):
        self.screen = "A"
        self.current_activity = ".MainActivity"
        self.current_package = "com.example.fakeapp"

    @property
    def page_source(self):
        return SCREEN_A_XML if self.screen == "A" else SCREEN_B_XML

    def save_screenshot(self, path):
        # write a tiny placeholder file so paths are real
        with open(path, "wb") as f:
            f.write(b"FAKESCREENSHOT")
        return True

    def find_element(self, by, value):
        # value is a resource-id string (AppiumBy.ID) in our fake screens
        known_ids = {
            "A": {"com.example.fakeapp:id/btn_settings", "com.example.fakeapp:id/input_search"},
            "B": {"com.example.fakeapp:id/switch_notify", "com.example.fakeapp:id/btn_back"},
        }
        if value in known_ids.get(self.screen, set()):
            return FakeElement(self, value)
        raise Exception(f"no such element: {value}")

    def _handle_click(self, resource_id):
        if resource_id == "com.example.fakeapp:id/btn_settings":
            self.screen = "B"
            self.current_activity = ".SettingsActivity"
        elif resource_id == "com.example.fakeapp:id/btn_back":
            self.screen = "A"
            self.current_activity = ".MainActivity"
        print(f"  [FakeDriver] now on screen {self.screen} ({self.current_activity})")

    def back(self):
        """Simulates the Android system back button (driver.back())."""
        if self.screen == "B":
            self.screen = "A"
            self.current_activity = ".MainActivity"
        print(f"  [FakeDriver] back() -> screen {self.screen} ({self.current_activity})")

    def get_window_size(self):
        return {"width": 1080, "height": 1920}

    def swipe(self, start_x, start_y, end_x, end_y, duration):
        print("  [FakeDriver] swipe (no-op on fake app)")

    def execute_script(self, script, params=None):
        print(f"  [FakeDriver] execute_script({script}, {params}) (no-op on fake app)")

    def quit(self):
        print("  [FakeDriver] quit()")