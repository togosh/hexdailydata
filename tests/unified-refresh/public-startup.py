"""Reuse actual blocked-reader/native-worker test; never a provider probe."""
import sys,importlib.util
from pathlib import Path
sys.dont_write_bytecode=True
W=Path(__file__).resolve().parents[2]
root=Path(sys.argv[1]).resolve()
allowed=Path(r'C:\Code\HEXDailyData-Subgraph-First-Launch-Proof-R2\unified-refresh-public-qualification-r2\fixtures')
assert root.is_relative_to(allowed) and root.is_dir()
spec=importlib.util.spec_from_file_location('denied_startup',W/'tests/trade-feed/stdin-isolation.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.actual('actual_isolated',root)
