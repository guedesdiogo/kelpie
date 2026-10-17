# Builds components/bundle.js and the mascot part of bundle.css from the webchat's own engine
# (apps/ingress/public/webchat/mascot*.js, mascot.css), so the system runs the shipped code.
import re, sys, pathlib
import os
# The engine: main's, which carries Offline (ADR-0047) since #412; ENGINE only for a newer one approved for it.
DS = pathlib.Path(__file__).resolve().parents[1]
ROOT = DS.parents[1]
W = pathlib.Path(os.environ.get('ENGINE', ROOT / 'apps/ingress/public/webchat'))
ORIGIN = os.environ.get('ENGINE_ORIGIN', 'apps/ingress/public/webchat/mascot*.js at main@59907ec, Offline included, unchanged\n * but for its import and export lines')
OUT = DS / 'project/components'

def module(path, deps):
    src = (W / path).read_text()
    names = re.findall(r'^export (?:function|const|class) (\w+)', src, re.M)
    src = re.sub(r'^export (function|const|class) ', r'\1 ', src, flags=re.M)
    def imp(m):
        spec, mod = m.group(1), m.group(2)
        return 'const {' + spec + '} = ' + deps[mod] + ';'
    src = re.sub(r'^import \{([^}]*)\} from "\./([\w-]+)\.js";', imp, src, flags=re.M | re.S)
    assert 'import ' not in re.sub(r'//.*', '', src).split('\n')[0]
    return src, names

states, sn = module('mascot-states.js', {})
art, an = module('mascot-art.js', {})
eng, en = module('mascot.js', {'mascot-art': 'art', 'mascot-states': 'states'})
helpers = (DS / 'src/helpers.js').read_text()
wrap = lambda name, src, names: f'  var {name} = (function () {{\n{src}\n  return {{ {", ".join(names)} }};\n  }})();\n'
out = ('/* Kelpie: the agent mascot engine (ADR-0045) and the previews\' motion helpers, as one classic script.\n'
       ' * The engine is ' + ORIGIN + '.\n'
       ' * window.Kelpie.mascot is the engine; window.Kelpie.ui the helpers. */\n'
       '(function () {\n  "use strict";\n'
       + wrap('states', states, sn) + wrap('art', art, an) + wrap('engine', eng, en) + helpers +
       '  window.Kelpie = { mascot: Object.assign({}, states, art, engine), ui: ui };\n})();\n')
for bad in ('</script', '<!--'):
    assert bad not in out.lower(), bad
(OUT / 'bundle.js').write_text(out)
css = (W / 'mascot.css').read_text()
start = css.index('.mascot-defs')
(DS / 'src/mascot.part.css').write_text(
    '/* The mascot (ADR-0045): apps/ingress/public/webchat/mascot.css, without its color tokens,\n'
    ' * which live in tokens.json (mascot-*). */\n' + css[start:])
print(len(out), 'bytes bundle.js;', len(sn), len(an), len(en), 'exports')
