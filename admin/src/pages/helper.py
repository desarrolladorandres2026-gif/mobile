import re
def rep(path, start_pred, new, end_tag=None):
    raw=open(path,'rb').read().decode('utf-8')
    crlf='\r\n' in raw
    L=raw.replace('\r\n','\n').split('\n')
    i=next(k for k,l in enumerate(L) if start_pred(k,L))
    ind=len(L[i])-len(L[i].lstrip(' '))
    tag=end_tag or ('</ul>' if L[i].strip().startswith('<ul') else '</dl>' if L[i].strip().startswith('<dl') else None)
    if end_tag=='AFTER_MAP':
        m=next(k for k in range(i,len(L)) if L[k].strip() in ('))}','})}'))
        j=m+1
        while not (L[j].strip()=='</div>' and L[j-1].strip() in ('))}','})}',')}')): j+=1
    else:
        j=next(k for k in range(i,len(L)) if L[k].strip()==tag and len(L[k])-len(L[k].lstrip(' '))==ind)
    pad=' '*ind
    new_lines=[pad+x if x else x for x in new.strip('\n').split('\n')]
    L[i:j+1]=new_lines
    out='\n'.join(L)
    open(path,'wb').write((out.replace('\n','\r\n') if crlf else out).encode('utf-8'))
def grid(headers, rows_jsx):
    th='\n'.join(f'<th className="table-header-cell">{h}</th>' for h in headers)
    return f'''<div className="table-container">
<div className="overflow-x-auto">
<table className="data-grid">
<thead>
<tr className="text-left">
{th}
</tr>
</thead>
<tbody>
{rows_jsx}
</tbody>
</table>
</div>
</div>'''
T='table-body-cell text-[var(--color-text-main)]'
