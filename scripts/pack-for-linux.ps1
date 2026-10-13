# Legacy entry point: fail before reading configs, building, copying or archiving.
$ErrorActionPreference = "Stop"
throw "pack-for-linux.ps1 is disabled: its legacy recursive copy can publish private data. Use a clean public checkout, run the privacy gates, then powershell -NoProfile -File scripts/pack-release.ps1 -Target linux. The maintained packer is not certified safe on a dirty runtime tree. See docs/PRIVACY-AND-PUBLISHING.md."
