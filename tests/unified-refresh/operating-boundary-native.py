"""Actual collector entries and real request children; only response I/O is synthetic."""
import sys,os,json,importlib.util,builtins
from pathlib import Path
sys.dont_write_bytecode=True
W=Path(__file__).resolve().parents[2];root=Path(sys.argv[1]).resolve()
def deny(event,args):
    if event.startswith('socket.'):raise PermissionError('DENIED_NETWORK_BOUNDARY')
sys.addaudithook(deny)
a=json.loads((root/'ADMISSION.json').read_bytes());f=json.loads((root/'FIXTURE.json').read_bytes())
assert a['operatingFormat']=='unified-operating-denied-boundary-1' and a['synthetic'] is True
folder={'trade':'trade-feed','market':'market-refresh','gas':'gas-feed','protocol':'protocol-feed','participants':'participant-refresh'}[a['family']]
sys.path[:0]=[str(W/'scripts/unified-refresh'),str(W/'scripts'/folder),str(W/'scripts/market-refresh')]
from durable import save
save(root/'NETWORK_DENIAL.json',{'dns':True,'sockets':True,'externalRequests':0,'realNativeChildren':True})
worker=str(W/'tests/unified-refresh/operating-boundary-worker.py')
real_print=builtins.print
def observed(value,*args,**kw):
    m=json.loads(value)
    if m.get('type')=='closed':save(root/'COMPLETION_EMITTER.json',{'entry':'actual '+folder+' collector','frame':m,'frameBytes':len(value.encode()),'syntheticResponses':True,'nativeClosureNotInjected':True})
    return real_print(value,*args,**kw)
builtins.print=observed
if a['family']=='trade':
    import client
    sys.path[:0]=[str(W/'scripts/trade-feed'),str(W/'scripts/unified-refresh')]
    import collector
    from offline_profile import TradeParent
    real_session=client.Session
    def runner(args,env,wait,reap):
        return client.worker_native([*args[:3],worker,args[-1]],env,wait,reap)
    def session(r,admission,**kw):
        return real_session(r,admission,runner=runner,parent_accounting=TradeParent(r,admission,kw['mono'],kw['sleep'],kw['wall']),**kw)
    collector.Session=session
    raise SystemExit(collector.main(offline_fixture=True))
else:
    import capture_client
    original=capture_client.WorkerTransport
    class ResponseChildren(original):
        def __init__(self,nonce,**kw):super().__init__(nonce,worker_path=Path(worker))
    capture_client.WorkerTransport=ResponseChildren
    import collector,job
    if f.get('postGrantReserve'):
        from combined import Combined
        original_phase=Combined.phase_check
        def exhausted_after_grant(self,*args,**kw):
            from operating_bridge import current
            if self.state['attempts']==1 and current().pending is not None:
                # Denied fixture: consume the reserve only AFTER the real permit.
                # Actual reserve(), collector ledger, no-dispatch emitter and parent
                # settlement execute; no worker or successful receipt is substituted.
                old_seconds=self.limits['seconds'];self.limits['seconds']=1
                try:return original_phase(self,*args,**kw)
                finally:self.limits['seconds']=old_seconds
            return original_phase(self,*args,**kw)
        Combined.phase_check=exhausted_after_grant
    if a['family']=='participants':
        old=collector.run_window
        def held(*args,**kw):
            from operating_bridge import current
            bridge=current();before=bridge.clock.epoch();bridge.sleep(f['delay']);after=bridge.clock.epoch()
            save(root/'REAL_WAIT.json',{'requestedSeconds':f['delay'],'elapsedSeconds':after-before,'start':before,'end':after})
            return old(*args,**kw)
        collector.run_window=held
    raise SystemExit(job.main(offline_fixture=True))
