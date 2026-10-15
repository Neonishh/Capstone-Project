"""Upload existing JSON output files from any Python pipeline."""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from manage import load_env
from save_run import save_run_to_db

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env')
    parser.add_argument('--platform', required=True, choices=['web', 'mobile'])
    parser.add_argument('--architecture', required=True, choices=['A', 'B'])
    for name in ('app', 'comparison', 'run-id', 'memory', 'cases', 'results'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--state', choices=['completed', 'incomplete'], default='completed')
    args = parser.parse_args()
    if args.env:
        load_env(args.env)
    def read(file):
        return json.loads(Path(file).read_text(encoding='utf-8-sig'))
    results = read(args.results)
    saved = save_run_to_db(dict(
        run_id=args.run_id, created_at=datetime.now(timezone.utc).isoformat(),
        platform=args.platform, architecture=args.architecture,
        app_id=args.app, comparison_id=args.comparison, execution_state=args.state,
        memory_log=read(args.memory), test_cases=read(args.cases),
        execution_results=results if isinstance(results, list) else results['results']))
    print('Uploaded successfully' if saved['uploaded'] else 'Saved locally; ' + saved['reason'])
    print('Run ID:', args.run_id)

if __name__ == '__main__':
    main()
