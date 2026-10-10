"""Bounded Windows pending-reader reproduction; default modes never use a network."""
import sys
sys.dont_write_bytecode = True

def deny_network(event, args):
    if event.startswith('socket.'):
        raise PermissionError('OFFLINE_NETWORK_DENIED')
sys.addaudithook(deny_network)

import ctypes, json, os, queue, subprocess, threading, time
from pathlib import Path
T = Path(r'C:\Code\HEXDailyData-Subgraph-First-Launch-Proof-R2\btc-eth-current-reference-freshness-r2\worker-stdin-isolation-r1')
W = Path(__file__).resolve().parents[2]

def emit(kind, **fields):
    print(json.dumps({'type':kind, **fields}), flush=True)

def pending_io(thread):
    """Kernel acknowledgement of pending I/O, not merely a started thread."""
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenThread.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    kernel.OpenThread.restype = ctypes.c_void_p
    kernel.GetThreadIOPendingFlag.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenThread(0x0040, False, thread.native_id)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        until = time.monotonic()+2
        while time.monotonic() < until:
            flag = ctypes.c_int()
            if not kernel.GetThreadIOPendingFlag(handle, ctypes.byref(flag)):
                raise ctypes.WinError(ctypes.get_last_error())
            if flag.value:
                return {'nativeThreadId':thread.native_id, 'pending':True, 'method':'GetThreadIOPendingFlag'}
            time.sleep(.002)
        raise AssertionError('Kernel pending-read barrier not established')
    finally:
        kernel.CloseHandle(handle)

def minimal(mode, folder):
    inbox = queue.Queue()
    thread = None
    if mode != 'no_reader_inherited':
        def one_read():
            inbox.put(sys.stdin.readline())
        thread = threading.Thread(target=one_read)
        thread.start()
        barrier = pending_io(thread)
    else:
        barrier = None
    emit('barrier', mode=mode, barrier=barrier)
    env = {k:v for k,v in os.environ.items() if k.upper() in ('SYSTEMROOT','WINDIR','COMSPEC')}
    env.update(TEMP=str(folder),TMP=str(folder),PYTHONIOENCODING='utf-8')
    child_file = folder/'minimal-child.py'
    child_file.write_text("import sys\ndef deny(e,a):\n if e.startswith('socket.'): raise PermissionError('OFFLINE_NETWORK_DENIED')\nsys.addaudithook(deny)\nprint('ENTRY',flush=True)\n",encoding='utf-8')
    before=time.monotonic()
    child=subprocess.Popen([sys.executable,'-I','-S',str(child_file)],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,stdin=subprocess.DEVNULL if mode=='pending_devnull' else None)
    if mode=='pending_release':
        # Reader is kernel-confirmed pending before spawn. Observe child still alive
        # before asking the Node owner to release the deliberate one-read reader.
        time.sleep(.4)
        emit('release', childStillRunning=child.poll() is None)
    timed=False
    try:
        out,err=child.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        timed=True;child.kill();out,err=child.communicate(timeout=2)
    finally:
        emit('close_input')
    if thread:
        thread.join(timeout=2)
        assert not thread.is_alive(), 'Diagnostic reader did not close'
    result={'mode':mode,'barrier':barrier,'timeout':timed,'reaped':child.poll() is not None,'exit':child.returncode,'seconds':time.monotonic()-before,'stdout':out.decode()[:2048],'stderr':err.decode()[:2048],'input':inbox.get_nowait() if not inbox.empty() else None,'readerClosed':thread is None or not thread.is_alive(),'synthetic':True,'networkRequests':0,'baseAdmissions':0,'interpreter':sys.executable,'version':sys.version,'flags':['-I','-S'],'cwd':str(Path.cwd()),'environmentNames':sorted(env)}
    (folder/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    emit('result',result=result)

def actual(mode, folder):
    sys.path.insert(0,str(W/'scripts/trade-feed'))
    import client
    import importlib.util
    spec=importlib.util.spec_from_file_location('actual_trade_collector',W/'scripts/trade-feed/collector.py')
    collector=importlib.util.module_from_spec(spec);spec.loader.exec_module(collector)
    start_reader=collector.start_reader
    incoming=queue.Queue()
    reader=start_reader(incoming)
    barrier=pending_io(reader)
    baseline=mode=='actual_inherited'
    emit('barrier',mode=mode,barrier=barrier)
    actual_default=client.Session.__init__.__defaults__[0]
    real_popen=subprocess.Popen
    launches=[]
    def offline_popen(args, **kwargs):
        assert Path(args[3])==W/'scripts/trade-feed/worker.py'
        args=[*args[:4],'--offline-prefix',*args[4:]]
        launches.append({'stdinPolicy':'DEVNULL' if kwargs.get('stdin')==subprocess.DEVNULL else 'INHERITED','flags':args[1:3]})
        return real_popen(args,**kwargs)
    subprocess.Popen=offline_popen
    results=[]
    try:
        for ordinal in range(1,2 if baseline else 3):
            root=folder/f'worker-{ordinal}'
            root.mkdir();(root/'temp').mkdir()
            bindings={str(p.relative_to(W)).replace('\\','/'):client.digest(p.read_bytes()) for p in [W/'scripts/trade-feed/client.py',W/'scripts/trade-feed/worker.py',W/'scripts/trade-feed/collector.py',W/'scripts/trade-feed/diagnostics.py',W/'scripts/trade-feed/authority.py',W/'scripts/benchmark-reference/collector.py']}
            a={'task':client.TASK,'family':'trade','synthetic':True,'fixtureIdentity':'SYNTHETIC_OFFLINE_WORKER_PREFIX','jobRoot':str(root),'nonce':'synthetic-only','startedAtUnixSeconds':time.time(),'runtimeFiles':bindings}
            client.save(root/'ADMISSION.json',a)
            # Preserve the actual Session default runner/Popen policy. Only shorten
            # this offline native wait and insert the hard-denied fixture mode.
            session=client.Session(root,a,runner=lambda args,env,wait,reap:actual_default(args,env,5,2))
            failure=None
            try:session.get(client.URLS[0],'synthetic_actual_reader')
            except ValueError as error:failure=str(error)
            finally:session.close('Synthetic diagnosis: '+str(failure))
            assert session.state['closureKnown'] and session.state['pending'] is None
            waiting_after=pending_io(reader)
            emit('ack',ordinal=ordinal)
            command=incoming.get(timeout=2)
            assert command=={'ok':True,'cycle':ordinal},command
            pending_io(reader)
            rows=session.state['requests']
            if baseline:
                assert all(r['native']['timeout'] and r['lastEstablishedPhase']=='worker_entry_not_established' for r in rows)
            else:
                assert len(rows)==1 and rows[0]['native']['exit']==0 and not rows[0]['native']['timeout']
                assert rows[0]['lastEstablishedPhase']=='offline_prefix_complete'
                assert rows[0]['integrityFailure']=='PermissionError: SYNTHETIC_PRECONNECT_STOP'
                assert client.strict_json((root/'01/response.json').read_bytes())['synthetic'] is True
            results.append({'ordinal':ordinal,'accounting':session.state,'readerStillPendingAfterWorker':waiting_after,'collectorCommand':command})
    finally:
        subprocess.Popen=real_popen
        emit('close_input');reader.join(timeout=2)
        assert not reader.is_alive(), 'Collector reader did not close'
    receipt={'mode':mode,'initialBarrier':barrier,'results':results,'launches':launches,'readerClosed':True,'actualReader':'collector.start_reader','actualRunner':actual_default.__name__,'syntheticCaptureAccepted':False,'publicRequests':0,'baseAdmissions':0,'synthetic':True}
    (folder/'RESULT.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
    emit('result',result=receipt)

if __name__=='__main__':
    if len(sys.argv)!=4 or sys.argv[1] not in ('minimal','actual'):
        print('Offline diagnostic only. Explicit scenario and owned fixture path required.')
    else:
        mode=sys.argv[2];folder=Path(sys.argv[3]).resolve()
        assert folder.is_relative_to(T/'fixtures') and folder.is_dir()
        if sys.argv[1]=='minimal':
            assert mode in ('no_reader_inherited','pending_inherited','pending_devnull','pending_release')
            minimal(mode,folder)
        else:
            assert mode in ('actual_inherited','actual_isolated')
            actual(mode,folder)
