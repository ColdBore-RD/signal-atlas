# Vendored libraries

The page loads nothing from the internet. These files are copied from npm packages.

| Folder | Package | Version | Licence |
|---|---|---|---|
| `three/` | `three` (build `three.module.min.js`, `three.core.min.js`, `examples/jsm/controls/OrbitControls.js`) | 0.180.0 | MIT |
| `fonts/inter-*` | `@fontsource/inter` | 5.2.8 | SIL OFL 1.1 |
| `fonts/jetbrains-mono-*` | `@fontsource/jetbrains-mono` | 5.x | SIL OFL 1.1 |

To update: `npm install three@<version>` in a scratch folder and copy the same three files.

One line of `three/addons/controls/OrbitControls.js` was changed: it imports `../../three.module.min.js` instead of the bare name `three`, so the page needs no import map and can run under a strict Content-Security-Policy.
