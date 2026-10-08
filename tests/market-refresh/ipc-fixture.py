"""Test-only physical stdio child: actual execute/Session/current/audit; no network/children."""
import sys,os,importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('fixtures',Path(__file__).with_name('client_test.py'))
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
from collector import execute
c=fixture.Clock()
sys.exit(execute(*sys.argv[1:],test_transport=fixture.Composed(),test_clock=c,test_sleep=c.sleep))
