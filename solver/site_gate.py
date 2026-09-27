"""Regression gate: a Pages release cannot mix cached modules across deploys."""
import json
from pathlib import Path
import re
import shutil
import tempfile

from build_site import PUBLIC, build_site

with tempfile.TemporaryDirectory(prefix='nw-site-gate-') as directory:
    root = Path(directory)
    source = root / 'source'
    shutil.copytree(PUBLIC, source)
    original = (source / 'index.html').read_bytes()
    output = root / 'output'
    release = build_site(output, source)
    html = (output / 'index.html').read_text()
    imports = re.findall(r"from ['\"](\./[^'\"]+\.js)['\"]", html)
    assert imports
    for specifier in imports:
        assert specifier.startswith(f'./{release}/'), specifier
        assert (output / specifier).is_file(), specifier
    workers = re.findall(r"new Worker\(['\"`]([^'\"`?]+)", html)
    assert workers == [f'{release}/engine.worker.js'], workers
    for module in (output / release).glob('*.js'):
        for specifier in re.findall(r"from ['\"](\./[^'\"]+)['\"]", module.read_text()):
            assert (module.parent / specifier).is_file(), (module.name, specifier)
    assert (output / release / 'fast_engine.js').is_file()
    # The service worker is registered from the root, pinned to this release, and
    # precaches exactly the release's modules (so an offline load has all of them).
    assert re.findall(r"register\(['\"]([^'\"]+)['\"]\)", html) == ['sw.js']
    sw = (output / 'sw.js').read_text()
    assert f"const RELEASE = '{release}';" in sw
    precache = json.loads(re.search(r"^const PRECACHE = (\[.*\]);", sw, re.M)[1])
    assert precache == sorted(p.name for p in (output / release).glob('*.js')), precache
    assert not (output / release / 'sw.js').exists()
    assert build_site(root / 'repeat', source) == release
    assert (root / 'repeat' / 'sw.js').read_text() == sw
    assert (source / 'index.html').read_bytes() == original
    # A transitive dependency changing must invalidate the entire module graph,
    # even if index.html and its direct imports have not changed.
    with (source / 'fast_engine.js').open('a') as engine:
        engine.write('\n// different engine build\n')
    next_release = build_site(root / 'next', source)
    assert next_release != release
    assert (root / 'next' / 'sw.js').read_bytes() != (output / 'sw.js').read_bytes()

print('SITE-GATE: PASS (versioned imports, worker and engine; deterministic releases; '
      'dependency invalidation; release-pinned service worker)')
