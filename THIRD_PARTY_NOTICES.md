# Third-party notices

`webui.html` is not written here: it is the web page of stable-diffusion.cpp's `sd-server`, built into one file by `build_webui.sh`. The built file
carries no license text of its own, so the notices of what is in it are kept here. Everything else in this repository is not covered by this file.

## sdcpp-webui

The page itself. https://github.com/leejet/sdcpp-webui, built from commit `8e7c11505925c0dbf9aaea56a3a5058b8690d66b` (2026-10-06).

```
MIT License

Copyright (c) 2026 leejet

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

## Vue

The page's only runtime dependency, version 3.5.32 (`@vue/reactivity`, `@vue/runtime-core`, `@vue/runtime-dom` and `@vue/shared` are in the built
file, each with this license). https://github.com/vuejs/core

```
The MIT License (MIT)

Copyright (c) 2018-present, Yuxi (Evan) You

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## When `webui.html` is rebuilt

`./build_webui.sh` pulls the latest sdcpp-webui and its lockfile's dependencies, so the commit and the Vue version above may no longer be the ones in the
file: update them here when the rebuilt file is committed (the commit is `git -C ~/imagegen/runtime/sdcpp-webui log -1`, Vue's version is in its
`pnpm-lock.yaml`), and check that the dependencies are still only Vue and that its license has not changed.
