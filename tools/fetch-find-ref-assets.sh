#!/bin/bash
set -e
mkdir -p "$HOME/Desktop/assets/regen"
curl -sSL -o "$HOME/Desktop/assets/bg-texture-purple.png" 'https://fanyi-cdn.cdn.bcebos.com/static/cat/asset/bg.ea77cf4b.png'
curl -sSL -o /tmp/liaison-ref-illustration.png 'https://fanyi-cdn.cdn.bcebos.com/static/cat/asset/lf_01.89a68ceb.png'
echo
echo "Downloaded:"
ls -lh "$HOME/Desktop/assets/bg-texture-purple.png" /tmp/liaison-ref-illustration.png
