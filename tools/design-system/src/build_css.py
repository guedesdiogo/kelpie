import os, pathlib
# Works inside tools/design-system, wherever it is run from.
os.chdir(pathlib.Path(__file__).resolve().parents[1])
src = pathlib.Path('src/css')
parts = [src / '0-base.css'] + sorted(p for p in src.iterdir() if p.name != '0-base.css')
css = '\n'.join(p.read_text().rstrip() + '\n' for p in parts) + '\n' + pathlib.Path('src/mascot.part.css').read_text()
assert '</style' not in css.lower()
pathlib.Path('project/components/bundle.css').write_text(css)
print(len(css), 'bytes bundle.css from', len(parts), 'files')
