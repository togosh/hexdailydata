import json
HEX="0x2b591e99afe9f32eaa6214f7b7629768c40eeb39"
def selection(r):
    return ' '.join(r['poolFields'])+' token0 { '+' '.join(r['tokenFields'])+' } token1 { '+' '.join(r['tokenFields'])+' }'

def meta(pin=None):
    arg='' if pin is None else '(block:{hash:'+json.dumps(pin['hash'])+'})'
    return '_meta'+arg+' { deployment hasIndexingErrors block { number hash timestamp } }'

def compile_data(job):
    if job['kind']!='pools':raise ValueError('Current pools only')
    r=job['recipe'];block='block:{hash:'+json.dumps(job['pin']['hash'])+'}'
    data='items:'+r['roots']['pools']['name']+'(first:2,where:{id_in:'+json.dumps(job['addresses'])+'},orderBy:id,orderDirection:asc,'+block+') { '+selection(r)+' }'
    bundle=' bundles:'+r['roots']['bundle']['name']+'(first:2,'+block+') { id '+r['bundleField']+' }' if r['bundleField'] else ''
    return '{ '+data+' '+meta(job['pin'])+bundle+' }'
