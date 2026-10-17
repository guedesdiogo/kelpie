# Regenerates project/guide/*.md from docs/design-system.md, the source of truth.
import pathlib, re
DS = pathlib.Path(__file__).resolve().parents[1]
doc = (DS.parents[1] / 'docs/design-system.md').read_text()
G = 'https://github.com/guedesdiogo/kelpie/blob/main/docs/'
# The guide is read on claude.ai, so the doc's relative links point at GitHub.
def links(s):
    s = re.sub(r'\]\((adr/[^)]+)\)', lambda m: '](' + G + m.group(1) + ')', s)
    return re.sub(r'\]\((viability-study\.md|design-system\.md)\)', lambda m: '](' + G + m.group(1) + ')', s)
def section(start, end):
    a = doc.index(start); b = doc.index(end, a + 1) if end else len(doc)
    return doc[a:b].rstrip() + '\n'
# The guide's pages start one heading level up.
def demote(s):
    out = []
    for line in s.split('\n'):
        if line.startswith('#### '): line = '### ' + line[5:]
        elif line.startswith('### '): line = '## ' + line[4:]
        out.append(line)
    return '\n'.join(out)
out = DS / 'project/guide'
before = {p.name: p.read_text() for p in out.iterdir()}
motion = section('### 4.1 Two grammars', '## 5. Patterns')
views = section('### 5.14 Moving between views', '### 5.15 The phone')
(out / '1-motion.md').write_text('# Motion\n\nSection 4 of `docs/design-system.md`. Token names here carry their CSS `--` prefix.\n\n' + links(demote(motion)) + '\n' + links(demote(views)))
mascot = section("### 5.19 The agent's mascot", '### 5.20 The conversation').split('\n', 1)[1]
(out / '2-mascot.md').write_text('# The mascot\n\nPattern 5.19 of `docs/design-system.md`. The engine is in `components/bundle.js` as `window.Kelpie.mascot`; the Mascot card runs it.\n' + links(demote(mascot)))
for name, title, start, end in [('3-implementation.md', 'Implementation notes', '## 6. Implementation notes', '## 7. Review checklist'), ('4-checklist.md', 'Review checklist', '## 7. Review checklist', '## 8. Designing'), ('5-new-designs.md', "Designing what isn't here yet", "## 8. Designing what isn't here yet", '## 9. Sources'), ('6-sources.md', 'Sources', '## 9. Sources', None)]:
    (out / name).write_text('# ' + title + '\n' + links(demote(section(start, end).split('\n', 1)[1])))
for p in sorted(out.iterdir()): print(('changed ' if before.get(p.name) != p.read_text() else 'same    ') + p.name)
