"""Stage Pages assets under a content-addressed release directory.

GitHub Pages caches each URL independently. A new HTML page must not import
old cached modules or workers, especially when their exports/WASM ABI changed.
"""
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys

PUBLIC = Path(__file__).resolve().parents[1] / 'public'


def build_site(output, source=PUBLIC):
    output, source = Path(output).resolve(), Path(source).resolve()
    if output == source or source in output.parents or output in source.parents:
        raise ValueError('site output must be separate from source')
    files = sorted(p for p in source.rglob('*') if p.is_file())
    digest = hashlib.sha256()
    for path in files:
        digest.update(path.relative_to(source).as_posix().encode() + b'\0')
        digest.update(path.read_bytes())
    release = f'assets/{digest.hexdigest()[:16]}'
    shutil.copytree(source, output, dirs_exist_ok=True)
    # All transitive relative imports stay within the same immutable release,
    # including engine.worker.js -> fastnw.js -> the embedded WASM module.
    # The service worker stays at the root, where its scope covers the page.
    modules = sorted(p.name for p in source.glob('*.js') if p.name != 'sw.js')
    for name in modules:
        destination = output / release / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / name, destination)
    html = (source / 'index.html').read_text()
    html = re.sub(r"from (['\"])\./([^'\"]+\.js)(?:\?[^'\"]*)?\1",
                  lambda m: f'from {m[1]}./{release}/{m[2]}{m[1]}', html)
    # Each worker's URL may carry its own query (see makeEngine in index.html).
    html, workers = re.subn(r"new Worker\((['\"`])engine\.worker\.js(?=[?'\"`])",
                           lambda m: f'new Worker({m[1]}{release}/engine.worker.js', html)
    if workers != 1:
        raise ValueError('expected one shared worker factory in the page')
    (output / 'index.html').write_text(html)
    # Pinning the release changes sw.js on every deploy, which is what makes
    # browsers install the new worker and precache the new modules.
    sw = (source / 'sw.js').read_text()
    sw, pinned = re.subn(r"^const RELEASE = null;", f"const RELEASE = '{release}';", sw, flags=re.M)
    sw, listed = re.subn(r"^const PRECACHE = \[\];", f"const PRECACHE = {json.dumps(modules)};",
                         sw, flags=re.M)
    if (pinned, listed) != (1, 1):
        raise ValueError('expected one RELEASE and one PRECACHE placeholder in sw.js')
    (output / 'sw.js').write_text(sw)
    return release


if __name__ == '__main__':
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else PUBLIC.parent / '_site'
    print(f'Built {output}: {build_site(output)}')
