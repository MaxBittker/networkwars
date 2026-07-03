#!/usr/bin/env python3
"""Overnight reconnect-and-resume watcher for the live series.

The iPhone Mirroring link can drop to a HARD "iPhone Not Found" state that no
software can clear (the physical phone must be woken/unlocked/near the Mac). This
watcher patiently taps "Try Again" every POLL seconds and, the instant a real
board reappears, relaunches series.py with the SAME hybrid+adaptive config so
overnight data collection resumes without waiting for a human. Exits after it
successfully launches the series, or after DEADLINE_S with no board.

Run in background:  nohup python3 reconnect_watch.py > reconnect_watch.log 2>&1 &
"""
import os
import subprocess
import sys
import time

import play as PL

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'runs', 'series_hybrid_adaptive.jsonl')
LOG = os.path.join(HERE, 'runs', 'series_hybrid_adaptive.log')
TRY_AGAIN = (160, 468)          # "Try Again" reconnect button, logical (px 319,937 /2)
POLL = 90
DEADLINE_S = 8 * 3600           # give up after 8h with no reconnect


def ts():
    return time.strftime('%b %e %H:%M:%S')


def board_now():
    """Return a parsed state if the phone shows a real board, else None."""
    PL.place(); time.sleep(0.3)
    p = PL.shot('watch_probe.png')
    ocr = PL.sh(PL.OCR, p).stdout.lower()
    if any(k in ocr for k in ('not found', 'interrupt', 'try again',
                              'iphone in use', 'connect')):
        return None, 'disconnected'
    st = PL.P.parse(p)
    if sum(st['counts'].values()) >= 12:
        return st, 'board'
    return None, 'other'


def launch_series():
    env = dict(os.environ)
    env['NW_ENGINE_SO'] = '../fast_engine.so'
    cmd = [sys.executable, '-u', os.path.join(HERE, 'series.py'),
           '--games', '200',
           '--sims', '16000', '--max-sims', '256000',
           '--deepthink-ratio', '3.0', '--deepthink-minvis', '3000',
           '--deepthink-behind', '2.0',
           '--out', OUT]
    logf = open(LOG, 'a', buffering=1)
    logf.write(f'\n=== reconnect_watch relaunch {ts()} ===\n')
    subprocess.Popen(cmd, cwd=HERE, env=env, stdout=logf, stderr=logf)


def series_running():
    r = subprocess.run(['pgrep', '-f', 'series.py --games 200'],
                       capture_output=True, text=True)
    return r.stdout.split()[0] if r.stdout.strip() else None


def main():
    """PERSISTENT supervisor: the iPhone link flaps (reconnect -> ~7 games -> drops
    to 'iPhone Not Found' -> series pauses). Loop forever until DEADLINE_S: whenever
    the series is NOT running, tap Try Again if disconnected, or relaunch the series
    the moment a board is back. Never exits on a single relaunch — survives repeated
    drops so overnight collection self-heals."""
    t0 = time.time()
    print(f'[{ts()}] persistent supervisor started; polling every {POLL}s', flush=True)
    while time.time() - t0 < DEADLINE_S:
        pid = series_running()
        if pid:
            time.sleep(POLL)                 # series healthy; don't interfere
            continue
        st, why = board_now()
        if why == 'board':
            print(f'[{ts()}] board back (sum={sum(st["counts"].values())}) — relaunching series',
                  flush=True)
            launch_series()
            time.sleep(15)
            print(f'[{ts()}] series pid: {series_running() or "FAILED TO START"}', flush=True)
        elif why == 'disconnected':
            PL.place(); time.sleep(0.2)
            PL.tap(*TRY_AGAIN)
            print(f'[{ts()}] series down + disconnected — tapped Try Again', flush=True)
        else:
            print(f'[{ts()}] series down, no board yet (unknown screen)', flush=True)
        time.sleep(POLL)
    print(f'[{ts()}] deadline reached; supervisor exiting', flush=True)


if __name__ == '__main__':
    main()
