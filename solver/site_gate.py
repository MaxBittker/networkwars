"""Regression gate: a Pages release cannot mix cached modules across deploys."""
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
    workers = re.findall(r"new Worker\(['\"]([^'\"]+)['\"]", html)
    assert workers == [f'{release}/engine.worker.js'], workers
    for module in (output / release).glob('*.js'):
        for specifier in re.findall(r"from ['\"](\./[^'\"]+)['\"]", module.read_text()):
            assert (module.parent / specifier).is_file(), (module.name, specifier)
    assert (output / release / 'fast_engine.js').is_file()
    assert build_site(root / 'repeat', source) == release
    assert (source / 'index.html').read_bytes() == original
    # A transitive dependency changing must invalidate the entire module graph,
    # even if index.html and its direct imports have not changed.
    with (source / 'fast_engine.js').open('a') as engine:
        engine.write('\n// different engine build\n')
    assert build_site(root / 'next', source) != release

print('SITE-GATE: PASS (versioned imports, worker and engine; deterministic releases; dependency invalidation)')
