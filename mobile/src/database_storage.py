"""Adapt mobile A/B artifacts to the shared database run contract."""

import sys
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from database.save_run import save_run_to_db, validate


def add_database_arguments(parser):
    parser.add_argument("--app", help="Database app ID; defaults to the Android package")
    parser.add_argument("--comparison", help="Experiment ID shared by A and B; enables database saving")


def write_exploration_metadata(directory, memory, metadata):
    """Bind provenance to the exact explored history; no credentials are stored."""
    fields = {k: metadata.get(k) for k in ("model", "exploration_stop_reason", "exploration_complete")}
    fields["memory_sha256"] = hashlib.sha256(json.dumps(memory, sort_keys=True).encode()).hexdigest()
    path = Path(directory) / "exploration_metadata.json"
    path.write_text(json.dumps(fields, indent=2), encoding="utf-8")
    return fields


def read_exploration_metadata(directory, memory):
    path = Path(directory) / "exploration_metadata.json"
    if not path.is_file():
        # Legacy provenance stays unknown; do not use today's model for old cases.
        return {}
    fields = json.loads(path.read_text(encoding="utf-8"))
    expected = hashlib.sha256(json.dumps(memory, sort_keys=True).encode()).hexdigest()
    if fields.get("memory_sha256") != expected:
        raise ValueError("Exploration metadata does not match the selected memory log")
    return {k: fields.get(k) for k in ("model", "exploration_stop_reason", "exploration_complete")}


def normalize_results(results):
    normalized = []
    for result in results:
        status = str(result["status"]).casefold()
        status = {"pass": "passed", "fail": "failed"}.get(status, status)
        if "duration_ms" in result:
            duration = result["duration_ms"]
        else:
            seconds = result.get("execution_time_seconds", result.get("execution_time", 0))
            duration = float(str(seconds).removesuffix("s")) * 1000
        normalized.append({
            "id": result.get("id") or result.get("test_case"),
            "status": status,
            "original_status": result["status"],
            "duration_ms": duration,
            "error": result.get("error"),
            "attachments": result.get("attachments", []),
        })
    return normalized


class MobileRun:
    """One execution attempt; upload retries reuse its saved bundle and run ID."""

    def __init__(self, architecture, app_id, comparison_id, memory_log, test_cases, *, metadata=None):
        self.run = dict(
            run_id=str(uuid4()), created_at=datetime.now(timezone.utc).isoformat(),
            platform="mobile", architecture=architecture, app_id=app_id,
            comparison_id=comparison_id, execution_state="incomplete",
            memory_log=memory_log,
            test_cases=[dict(case, id=case.get("test_case_id") or case.get("id"))
                        for case in test_cases],
            execution_results=[],
        )
        self.run.update({key: (metadata or {}).get(key)
                         for key in ("model", "exploration_stop_reason", "exploration_complete")})
        self.run = validate(self.run)

    def save(self, results, *, finished=False):
        self.run["execution_results"] = normalize_results(results)
        self.run["execution_state"] = (
            "completed" if finished and self.run["test_cases"]
            and len(results) == len(self.run["test_cases"]) else "incomplete"
        )
        saved = save_run_to_db(self.run)
        outcome = "uploaded" if saved["uploaded"] else "saved locally: " + saved["reason"]
        print(f"[database] {self.run['run_id']} ({self.run['execution_state']}): {outcome}")
        print(f"[database] Bundle: {saved['file']}")
        return saved
