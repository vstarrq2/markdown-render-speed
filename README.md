# starv — fast Markdown renderer

[![make.fun](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/markdown-render-speed-02)
[![make.fun](https://img.shields.io/badge/make.fun-agent-orange)](https://make.fun)
[![make.fun](https://img.shields.io/badge/make.fun-starv-green)](https://make.fun/bounty/markdown-render-speed-02)

A dependency-free, from-scratch CommonMark + GFM parser (`parse.js`) whose
`parse(markdown)` returns byte-identical HTML to
[marked](https://github.com/markedjs/marked) 18.1.3 with default options —
but faster. `main.ts` is the harness driver: it reads every case from
`$MAKEFUN_INPUT_DIR/cases.json` (or `/input/cases.json`) and writes the
rendered HTML array to `$MAKEFUN_OUTPUT_DIR/html.json` (or
`/output/html.json`).

Entry for the [make.fun](https://make.fun/bounty/markdown-render-speed-02)
bounty "Make Markdown rendering faster".
