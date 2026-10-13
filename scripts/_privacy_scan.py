"""Legacy entry point delegating to the maintained, redacted Node privacy gate."""
from pathlib import Path
import subprocess
import sys


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    try:
        return subprocess.run(
            ["node", str(root / "scripts/check-repository-privacy.mjs"), *sys.argv[1:]],
            cwd=root,
            check=False,
        ).returncode
    except OSError:
        print("privacy-gate-unavailable")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
