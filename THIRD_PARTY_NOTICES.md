# Third-party notices

Arma Reforger Launcher is distributed under GPL-3.0-only for original project code and documentation. Third-party components retain the licenses and notices below; the project GPL grant does not replace them.

## Electron, Chromium and Node.js

The Electron runtime includes Electron, Chromium, Node.js and additional components. Packaged releases must retain the runtime's complete license files, including `LICENSE.electron.txt` and `LICENSES.chromium.html`. Those files contain the component-specific terms and acknowledgements.

- Electron: OpenJS Foundation and Electron contributors, MIT License.
- Node.js: Node.js contributors, MIT License and other component notices.
- Chromium: The Chromium Authors, BSD-style and other component licenses.

## Application dependencies

The pinned production dependency graph includes these packages. Their license files remain with the packages inside the application archive and must be preserved when redistributing them. The lockfile records exact dependencies; this table describes the initial GPL source release.

| Package | Version | License |
| --- | --- | --- |
| electron-updater | 6.8.9 | MIT |
| builder-util-runtime | 9.7.0 | MIT |
| fs-extra | 10.1.0 | MIT |
| graceful-fs | 4.2.11 | ISC |
| jsonfile | 6.2.1 | MIT |
| universalify | 2.0.1 | MIT |
| js-yaml | 4.3.1 | MIT |
| argparse | 2.0.1 | Python-2.0 |
| lazy-val | 1.0.5 | MIT |
| lodash.escaperegexp | 4.1.2 | MIT |
| lodash.isequal | 4.5.0 | MIT |
| semver | 7.7.4 | ISC |
| tiny-typed-emitter | 2.1.0 | MIT |
| debug | 4.4.3 | MIT |
| ms | 2.1.3 | MIT |
| sax | 1.6.1 | BlueOak-1.0.0 |

### electron-updater

Copyright (c) 2015 Loopline Systems.
Copyright (c) 2016-2026 electron-builder contributors.

Source: [electron-builder](https://github.com/electron-userland/electron-builder). The MIT license text distributed with electron-updater follows:

The MIT License (MIT)

Copyright (c) 2015 Loopline Systems

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



### lazy-val

Author: Vladimir Krivosheev. License: MIT, as declared in the package metadata.
Source: [lazy-val](https://github.com/develar/lazy-val). Version 1.0.5 does not package a separate license-text file; its declared MIT terms are reproduced here with the author's attribution.

The MIT License (MIT)

Author: Vladimir Krivosheev (MIT license declaration in package metadata)

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



## Lucide and Feather icons

Icons under `src/renderer/assets/icons/` identified as Lucide use lucide-static 1.31.0. The complete upstream notice also preserves the MIT terms for icons derived from Feather. Retain both notices, including when an individual SVG is copied without its package.

Earlier launcher notices attributed Lucide as Copyright (c) 2022 Lucide Contributors. That acknowledgement is preserved here alongside the current upstream notice.

Source: [Lucide 1.31.0 license](https://github.com/lucide-icons/lucide/blob/1.31.0/LICENSE).

ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

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


## Oswald font

Copyright 2016 The Oswald Project Authors (https://github.com/googlefonts/OswaldFont).

The unmodified Oswald variable font at `src/renderer/assets/fonts/Oswald-Variable.ttf` is licensed under the SIL Open Font License, Version 1.1. The complete license is included at [src/renderer/assets/fonts/OFL-Oswald.txt](src/renderer/assets/fonts/OFL-Oswald.txt) and must accompany redistributed font copies. The font retains OFL terms; it is not relicensed under GPL.

Source: [Google Fonts Oswald](https://github.com/google/fonts/tree/main/ofl/oswald).

## Discord mark and launcher artwork

`src/renderer/assets/icons/discord.svg` depicts the Discord logo as a link to the community's Discord service. Discord and its logo are the property of Discord Inc.; this mark is not claimed as original ALGZ artwork or relicensed under GPL. See [Discord brand guidelines](https://discord.com/branding).

`src/renderer/assets/app-icon.png` is the orange LAR monogram supplied by the project owner in September 2026, prepared for application-icon use with AI-assisted cleanup. `src/renderer/assets/launcher-cover.png` is owner-provided artwork retained from the existing launcher. This describes their project provenance and does not claim ownership of any third-party marks or material depicted in them. The GPL grant covers only rights held by the project authors.

## Build tools

Electron, electron-builder and @electron/fuses use the MIT License. They and their build-time dependencies retain the notices shipped with their packages. Build tools are installed from the pinned manifests; their sources and licenses are not replaced by the launcher license.

## Game names, engine and services

ARMA, Arma Reforger and Bohemia Interactive are trademarks of Bohemia Interactive a.s. Steam and related marks belong to Valve Corporation. Workshop content remains the property of its respective authors and retains its own licensing terms.

The original `ALGZLauncherWorkshopBridge` script is distributed with the project under GPL-3.0-only. It requires a separately installed game and communicates with its APIs; the Arma Reforger engine, game data, Steam client and Workshop content are not part of this source distribution and are not relicensed.

Arma Reforger Launcher is an independent community project and is not affiliated with, endorsed by or authorized by Bohemia Interactive a.s., Valve Corporation or Discord Inc.
