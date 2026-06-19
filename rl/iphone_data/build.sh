#!/bin/bash
# Compile the Swift helpers used by the iPhone-Mirroring pipeline.
set -e
cd "$(dirname "$0")"
for t in tap wininfo ocr; do swiftc -O "$t.swift" -o "$t" && echo "built $t"; done
