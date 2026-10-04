# FSRCNNX

`FSRCNNX_x2_8-0-4-1.glsl` and `FSRCNNX_x2_16-0-4-1.glsl` are by igv
(Copyright (C) 2017-2021 igv), written as "user shaders" for the mpv video
player. They are here exactly as published, not changed in any way.

They are under the GNU Lesser General Public License, version 3.0 or (at your
option) any later version. That licence is in `COPYING.LESSER`, and the GNU
General Public License it builds on is in `COPYING`. The rest of Headroom HDR
is under the MIT licence (see `LICENSE` at the top); these two files are not.

Headroom HDR uses them for the "Best" level of its Upscaling setting. It reads
a file as text when it is first needed and turns each of its passes into the
shader language browsers use (see `upnet.js`). To use a changed version of
either file, edit or replace it here and reload the extension.
