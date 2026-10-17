# Test only (never published): compiles tokens.json the way format.md describes tokens.css, and
# wraps each preview in the frame the page gives it.
import json, pathlib, re, os
# Works inside tools/design-system, wherever it is run from; test/ is ignored by git.
os.chdir(pathlib.Path(__file__).resolve().parents[1])
pathlib.Path('test/c').mkdir(parents=True, exist_ok=True)
t = json.load(open('project/tokens.json'))
themes = [th['id'] for th in t['color']['themes']]
def val(tok, th):
    v = tok['value']
    return v if isinstance(v, str) else v.get(th, v[themes[0]])
out = []
for i, th in enumerate(themes):
    sel = ':root, [data-theme="%s"]' % th if i == 0 else '[data-theme="%s"]' % th
    out.append(sel + ' {' + ''.join('--%s: %s;' % (c['name'], val(c, th)) for c in t['color']['tokens']) + ''.join('--%s: %s;' % (s['name'], s['value']) for s in t['shadow']['tokens']) + '}')
other = ''
for fam in ['spacing', 'radius', 'duration', 'easing', 'distance', 'scale']:
    other += ''.join('--%s: %s;' % (x['name'], x['value']) for x in t[fam]['tokens'])
other += ''.join('--font-%s: %s;' % (k, v) for k, v in t['type']['families'].items())
out.append(':root {' + other + '}')
for g in t['type']['groups']:
    for s in g['styles']:
        fam = s.get('family', g['family'])
        out.append('.%s { font-family: var(--font-%s); font-size: %s; line-height: %s; font-weight: %s;%s }' % (s['name'], fam, s['fontSize'], s['lineHeight'], s['fontWeight'], (' letter-spacing: %s;' % s['letterSpacing']) if 'letterSpacing' in s else ''))
for f in t['type']['fonts']:
    out.append('@font-face { font-family: "%s"; src: url("../project/%s") format("woff2"); font-weight: %s; font-style: %s; }' % (f['family'], f['file'], f['weight'], f['style']))
pathlib.Path('test/tokens.css').write_text('\n'.join(out))
comps = sorted(p.name for p in pathlib.Path('project/components').iterdir() if (p / 'preview.html').exists())
for c in comps:
    html = (pathlib.Path('project/components') / c / 'preview.html').read_text()
    head = '<link rel="stylesheet" href="../../tokens.css"><link rel="stylesheet" href="../../../project/components/bundle.css"><script src="../../../project/components/bundle.js"></script>'
    html = re.sub(r'<head>', '<head>' + head, html, count=1)
    html = html.replace('<html>', '<html data-theme="light">', 1)
    d = pathlib.Path('test/c') / c; d.mkdir(parents=True, exist_ok=True)
    (d / 'index.html').write_text(html)
idx = '<!doctype html><meta charset="utf-8"><style>body{margin:0;font:13px sans-serif;background:#ccc}iframe{display:block;width:760px;border:0;margin:0 0 12px}h3{margin:8px}</style>'
for c in comps:
    h = re.search(r'height=(\d+)', (pathlib.Path('project/components') / c / 'preview.html').read_text().split('\n')[0])
    idx += '<h3>%s</h3><iframe src="c/%s/index.html" style="height:%spx"></iframe>' % (c, c, h.group(1) if h else 200)
pathlib.Path('test/index.html').write_text(idx)
print(len(comps), 'previews:', ' '.join(comps))
