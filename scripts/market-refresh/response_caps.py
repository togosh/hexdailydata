"""Exact current-query wire-body liabilities."""
def response_capacity(job):
    if job['kind']=='rpc':return 524288 if job.get('method','eth_getBlockByNumber')=='eth_getBlockByNumber' else 4096
    return {'meta':65536,'pools':262144}[job['kind']]
