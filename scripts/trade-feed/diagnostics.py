"""Small durable worker phase receipts; never environment or network tracing."""
import json
import os
import time
from pathlib import Path

PHASE_CAP = 8192  # Leaves room inside 16 KiB for bounded native/error diagnostics.


class Phases:
    def __init__(self, folder):
        self.path = Path(folder) / 'PHASES.ndjson'
        self.started = time.monotonic()
        self.used = 0
        self.last = None
        self.file = self.path.open('xb')

    def emit(self, event, **fields):
        raw = (json.dumps({'event': event, 'elapsedSeconds': time.monotonic()-self.started,
                           'unixSeconds': time.time(), **fields}, separators=(',', ':'))+'\n').encode()
        if self.used+len(raw) > PHASE_CAP:
            raise ValueError('Diagnostic bound')
        self.file.write(raw)
        self.file.flush()
        os.fsync(self.file.fileno())
        self.used += len(raw)
        self.last = event

    def close(self):
        self.file.close()
