# Third-party notices

The eval sets in `evals/` include material from the projects and datasets below, used under their licenses. No third-party code ships in the mod itself (`hooks/`). Every imported case records its exact source (repository or dataset, commit or revision, file, and upstream identifier) in its `source` field, and `evals/import/` rebuilds each corpus from those pinned sources.

## Changes made to all imported material

Commands and requests were copied verbatim, except that tldr-pages placeholders such as `{{path/to/file}}` were filled in mechanically. Each command was paired with a user request (its upstream request where one existed, otherwise an unrelated everyday request or the user pasting the command), given a project directory, and labeled for this gate by two annotators. Upstream verdicts are kept in `source.label` but were not used as labels, except for the unaudited nah cases, which keep nah's "block" verdict.

## MIT License

Used under the MIT License, with these copyright notices:

| Project | Copyright | Used in |
| - | - | - |
| [manuelschipper/nah](https://github.com/manuelschipper/nah) | Copyright (c) 2026 Manuel Schipper | `evals/corpus/nah.json`; the command capture behind `swe.json` and `tbench.json` |
| [DevMortimer/pi-warden](https://github.com/DevMortimer/pi-warden) | Copyright (c) 2026 Ryan Gapac | `evals/corpus/prior-art.json` |
| [jomatsu/pi-jev-auto-mode](https://github.com/jomatsu/pi-jev-auto-mode) | Copyright (c) 2026 jomatsu | `evals/corpus/prior-art.json`; six cases in `evals/cases.json` (r02, r08, a01, u01, u05, u06) adapted from five fixtures in `scripts/fixtures.ts` |
| [dys-org/pi-jev-gate](https://github.com/dys-org/pi-jev-gate) | Copyright (c) 2026 jomatsu | `evals/corpus/prior-art.json` |
| [jesset/pi-verdict](https://github.com/jesset/pi-verdict) | Copyright (c) 2026 Jesset | `evals/corpus/prior-art.json` |
| [RahulBalakavi/claude-code-jev](https://github.com/RahulBalakavi/claude-code-jev) | Copyright (c) 2026 Jev Auto Mode contributors | `evals/corpus/prior-art.json` |
| [SWE-bench/SWE-smith-trajectories](https://huggingface.co/datasets/SWE-bench/SWE-smith-trajectories) | Copyright the SWE-smith authors, MIT per the dataset card | `evals/corpus/swe.json` |

```text
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Creative Commons Attribution 4.0 International (CC BY 4.0)

Licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), and changed as described above:

- [tldr-pages](https://github.com/tldr-pages/tldr), copyright © 2014–present the tldr-pages team and contributors: command examples and their descriptions in `evals/corpus/tldr.json`.
- [nebius/SWE-agent-trajectories](https://huggingface.co/datasets/nebius/SWE-agent-trajectories) by Nebius: commands in `evals/corpus/swe.json`.
- [nvidia/SWE-Hero-openhands-trajectories](https://huggingface.co/datasets/nvidia/SWE-Hero-openhands-trajectories) by NVIDIA: commands in `evals/corpus/swe.json`.

## Apache License 2.0

- [yoonholee/terminalbench-trajectories](https://huggingface.co/datasets/yoonholee/terminalbench-trajectories): commands in `evals/corpus/tbench.json`, licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0), and changed as described above.
