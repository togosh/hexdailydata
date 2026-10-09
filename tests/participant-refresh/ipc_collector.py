"""Actual collector.execute and IPC, with a serial injected empty-window transport."""
import os,sys
from pathlib import Path
output,preflight=sys.argv[1:]
os.environ['HDD_TASK_ROOT']=str(Path(preflight).parent)
sys.path.insert(0,str(Path(__file__).parent))
from client_test import Clock,Fixture
from collector import execute
clock=Clock();fixture=Fixture(clock,holders=0)
fixture.data_rows=lambda *args,**kwargs:[]
raise SystemExit(execute(output,preflight,test_transport=fixture,test_clock=clock,test_sleep=clock.sleep))
