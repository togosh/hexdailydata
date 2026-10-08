"""Finite version-bound error envelopes; no policy can accept error data."""
import re
CLASSIFICATION='UPSTREAM_DUPLICATE_PREPARED_STATEMENT'
DATABASE_CLASSIFICATION='UPSTREAM_DATABASE_UNAVAILABLE'
MISSING_CLASSIFICATION='UPSTREAM_MISSING_PREPARED_STATEMENT'
UNNAMED_CLASSIFICATION='UPSTREAM_UNNAMED_PREPARED_STATEMENT'
MIXED_CLASSIFICATION='UPSTREAM_KNOWN_TRANSIENT_ERROR_LIST'
CLASSIFICATIONS={CLASSIFICATION,DATABASE_CLASSIFICATION,MIXED_CLASSIFICATION,MISSING_CLASSIFICATION,UNNAMED_CLASSIFICATION}
PATTERN=re.compile(r'Store error: store error: prepared statement "__diesel_stmt_[0-9]{1,10}" already exists')
MISSING_PATTERN=re.compile(r'Store error: store error: prepared statement "__diesel_stmt_[0-9]{1,10}" does not exist')
PROFILES={'R2':(1,False),'R3':(1,True),'R4':(16,True),'HOLDER_R1':(16,True),'HOLDER_R2':(16,True),'HOLDER_R3':(16,True)}

def classify_error_only(parsed,cap,policy_version='R4'):
    if policy_version not in PROFILES:raise ValueError('Unknown retry policy version')
    maximum,allow_database=PROFILES[policy_version]
    if type(cap.get('status')) is not int or cap['status']!=200:return None
    for key in ['complete','framingValidated','bodyDurable','childReaped','connectionClosed','closureKnown','closedWithinDeadline']:
        if cap.get(key) is not True:return None
    if any(cap.get(key) for key in ['transportError','failureKind','parseError','validationError','accessRestricted']):return None
    if type(cap.get('expectedBodyBytes')) is not int or cap['expectedBodyBytes']!=cap.get('responseBytes'):return None
    if not isinstance(parsed,dict) or set(parsed) not in ({'errors'},{'errors','data'}):return None
    if 'data' in parsed and parsed['data'] is not None:return None
    errors=parsed['errors']
    if not isinstance(errors,list) or not 1<=len(errors)<=maximum:return None
    classes=set()
    for error in errors:
        if not isinstance(error,dict) or set(error)!={'message'} or not isinstance(error['message'],str):return None
        if PATTERN.fullmatch(error['message']):classes.add(CLASSIFICATION)
        elif policy_version in ('HOLDER_R2','HOLDER_R3') and MISSING_PATTERN.fullmatch(error['message']):classes.add(MISSING_CLASSIFICATION)
        elif policy_version=='HOLDER_R3' and error['message']=='Store error: store error: unnamed prepared statement does not exist':classes.add(UNNAMED_CLASSIFICATION)
        elif allow_database and error['message']=='Store error: database unavailable':classes.add(DATABASE_CLASSIFICATION)
        else:return None
    return next(iter(classes)) if len(classes)==1 else MIXED_CLASSIFICATION

def classify_duplicate_statement(parsed,cap):return classify_error_only(parsed,cap,'R2')
