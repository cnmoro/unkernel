# The browser page (`web/`)

A static page: a full-screen terminal ([wterm](https://wterm.dev/)), with
more terminal windows over vsock, a tmux-style status line at the bottom
and terminal-style dialogs, built with React and Tailwind (v4, a black
theme after Vercel's Geist), Vite (client) and Nitro (server and route
rules), on the SDK from source. The top-level README.md describes it for
users.

## Files

`web/index.html` (the inline error bootstrap, and fallback markup that
React replaces), and in `web/src/`: `main.tsx` (entry: config, renders the
app, preflight with the SDK's `checkSupport()`), `config.ts` (the
settings, kept in localStorage, documented at its top), `store.ts` (the UI state, read with
`useStore()`), `ui.ts` (`KW.ui`: the imperative API boot.ts and main.tsx
drive, plus `nextSettings()`), `shortcuts.ts`, `boot.ts` (terminal and boot,
a separate chunk loaded only after the preflight passes), `windows.ts`
(terminal windows 1-9), `bottom.ts` (keeps a terminal at its bottom when
it gets shorter), `net.ts` (Wisp only), `apk.ts` (apk index prefetch), `download.ts` (files the page fetches for the guest), `sudo.ts` (root in the guest: `SUDO_SH`, `execAsRoot()`), `sdk.ts`, `kw.ts` (`window.KW`),
`data.ts` (the data disk), `session.ts` (the suspended session), `display.ts` (the guest display's state, the
mode offered, keyboard routing), `audio.ts` (Web Audio output),
`preview.ts` (the guest preview's page side), `open.ts` (the guest's
`open` and `xdg-open`, host commands: a URL on the guest's own address in
the preview, any other http(s) URL in a new tab, each only after the user
confirms), `sw.ts` (the service
worker's registration and the update check), `launcher.ts` (how a demo
runs; the demos are in `src/demos/`), `style.css`
(Tailwind theme, the dialog, wterm's colours). `src/components/`: `App.tsx`
(layout, viewport, key bar visibility, pinch), `Bar.tsx` (the status line), `Launcher.tsx` (its first item and the
launcher overlay),
`Panel.tsx` (the dialog), `Options.tsx`, `Display.tsx` (the display layer,
rotation, mouse and touch input, touch controls), `Keys.tsx` (extra keys),
`Overlays.tsx` (splash, toast, paste and confirm dialogs), `About.tsx`
(the status line's triangle and the credits dialog), `Preview.tsx`
(the preview panel), `icons.tsx`. `src/env.d.ts` declares `__KW_BUILD__`,
which `vite.config.ts` defines: the Linux release read from the committed
kernel's banner, the kernel's release tag and the page's commit (empty
where git is missing or the clone is too shallow). `web/public/vm-sw.js` is the page's
service worker (the preview's relay), `web/server/vm.ts` the preview's server fallback,
`web/server/distros.ts` the built Node server's `/distros/` handler and
`web/server/range.ts` the Range logic it shares with the dev server,
`web/scripts/kernel.ts` what the page runs (below).
`web/public/manifest.webmanifest` makes the page installable (standalone, black); its icons
`icon-192.png`, `icon-512.png` (the whole logo at 6x and 16x), `icon-maskable-512.png` (inside the
border, corners filled, opaque) and `apple-touch-icon.png` are `assets/logo.svg` rendered at 32 px
and scaled nearest neighbour (`magick -filter point`).
`web/vite.config.ts` holds the COOP/COEP headers (Nitro route rules, plus
the dev server's own responses), `__KW_BUILD__`, `virtual:unkernel-kernel`
(the kernel's URLs and the list of images), the dev server's `/distros/`
middleware, and the build step that copies the images into the output
(below).

## The page's kernel and distro images

The page runs the base bundle `unkernel.wasm` (the kernel and the base
initramfs, with the data disk template and the SMP patch section) and boots
it with a read-only distro image (`alpine.erofs`, `debian.erofs`) that it
attaches by URL and reads lazily with Range requests (the SDK's
`createKernel({ distro })`, js.md, Disks). `pageSource()` in
`web/scripts/kernel.ts` (described at its top) picks both when the dev
server starts or a page build begins (the `unkernel:kernel` plugin's
`config` hook in `vite.config.ts`, before anything is served or built), and
logs which and why (a build between two lines of `=`). Building or
deploying the page needs no kernel toolchain.

- The source, in this order:
  1. `KW_KERNEL=<file>` and/or `KW_DISTROS=<dir>` (relative to `web/`):
     that base bundle and the images in that directory (`<name>.erofs`, or
     `<name>.ext4` where there is no `.erofs`; `distros.json` there gives
     image ids), the other part from the local build, whatever `KW_LOCAL`
     says.
  2. A local build, when one may be used: `KW_LOCAL=1` forces it,
     `KW_LOCAL=0` forbids it, and by default it is used unless `CI` or
     `VERCEL` is set (a deploy or CI build has no `vendor/` and must ship
     a release). It needs `vendor/build/bundle/unkernel.wasm` (`kernel/build.sh
     base`) and at least one image in `vendor/build/distro/`
     (`kernel/build.sh distro`; both from `kernel/build.sh all`).
  3. Else the newest non-draft release of `pithings/unkernel`
     (`.github/workflows/release.yml`; `KW_KERNEL_RELEASE=<tag>` picks
     one), which must carry `unkernel.wasm`, `distros.json` and every image
     `distros.json` names. A release without them (every release before
     the base bundle: `unkernel-alpine.wasm` only) fails the build with
     what to do: build locally (`kernel/build.sh all`), cut a release, or
     name a release that has them. So a deploy (Vercel) and CI ship a
     release, never a local build.
  1 and 2 show as "local build" in the About dialog, 3 as the release's tag.
- A release is downloaded at build time (the dev server only when it has no
  copy yet, and then without a network check), because GitHub serves
  release assets without CORS (both the `github.com` redirect and
  `release-assets.githubusercontent.com`), so the browser cannot fetch
  them, and CDNs such as jsDelivr only serve files from the git tree. The
  copy is `web/kernel/release/` (gitignored: `unkernel.wasm`,
  `distros.json`, the images, `release.json` with the tag and every file's
  sha256). Everything is checked in a temporary directory before it
  replaces that copy (a rename), so a refused or broken release leaves
  `web/kernel/` as it was: `distros.json` first (its `abi` must be
  `include/kw_emu.h`'s `KW_ABI_VERSION`, its entries well formed), then
  `unkernel.wasm` (the API's sha256 digest where there is one, wasm magic,
  its own ABI from `kernelInfo()` in `kernel/tools/bundle.mjs`, its base
  id against `distros.json`'s `base`, `bundleInfo()` in
  `guest/tools/distros-json.mjs`), then each image (size and sha256 from
  `distros.json`, and the API's digest). An image the copy already has
  with that sha256 is reused, and a build whose newest release is the
  copy's downloads nothing. The GitHub API gives the newest release and the
  digests; without `GITHUB_TOKEN` (or `GH_TOKEN`) it allows 60 requests an
  hour per IP, so on any API failure the build reads the newest tag from
  `releases.atom` and downloads from the usual URLs (no digests; the
  sha256 in `distros.json` still checks the images). If GitHub cannot be
  reached, a build keeps the copy (when it is the tag asked for).
  `KW_GITHUB_API` and `KW_GITHUB` replace `https://api.github.com` and
  `https://github.com`, for a stand-in server. Checked 2026-11-19 against
  such a stand-in: a complete release built and booted (Alpine, Debian),
  a second build downloaded nothing, and a release without
  `distros.json`, one without an image, one whose `distros.json` says
  another ABI and one with a wrong image sha256 each failed with
  `web/kernel/` unchanged; the real newest release (v0.1.0-261117-0e4b2ec)
  fails with that message.
- The kernel must match the page: a local base bundle whose kwemu ABI is
  not `KW_ABI_VERSION` only gets a warning, a release is refused (above).
  The page's texts and demos (the Ubuntu demo's arm64 tarball, the
  launcher's aarch64 packages) are written for this checkout's guest.
  Order after an ABI or guest change: merge, cut a release (the workflow),
  then deploy the page; a page build that takes the newest release before
  then (CI, Vercel, `KW_LOCAL=0`) fails (or give `KW_KERNEL` and
  `KW_DISTROS`, `KW_LOCAL=1` or a matching `KW_KERNEL_RELEASE`). A
  release changes a deployed page only once the page is rebuilt.
- The kernel's URLs (`virtual:unkernel-kernel`'s `kernelUrl` and
  `kernelSmpUrl`, which `src/sdk.ts` exports): `baseSplit()` takes the
  SMP patch section off the bundle: the UP kernel is the bundle without it
  (byte for byte the bundle when it has none), the SMP one the kernel the
  patch makes with the same initramfs, command line and data disk template
  (js/core/kpatch.ts; `kernelSmpUrl` is null without the section). A build
  emits both from memory as hashed assets (`unkernel-<hash>.wasm`,
  `unkernel-smp-<hash>.wasm`), so it never touches the dev server's files;
  the dev server writes them to `web/kernel/page/<16 hex digits of the
  bundle's sha256>/` (`splitBase()`; the four used last are kept, so dev
  servers of different bundles do not overwrite each other) and serves
  them as `/@fs/` files, split again when a local bundle changes. UP
  visitors download only the UP kernel (8.4 MiB, about 4.7 MiB
  compressed); only a load with several CPUs fetches the SMP one (Several
  CPUs, below).
- The images' URLs and caching, with `virtual:unkernel-kernel`'s
  `distros` list (`{ name, url, size, imageId? }`, debian first;
  `imageId` where `distros.json` gives it, else the page reads it from
  `/run/kw-base`):
  - A build names each image by its content,
    `/distros/<name>-<16 hex digits of its sha256>.erofs`, and copies it
    (a real file with the source's mtime; never anything else from its
    directory, whose tar and ext4 files are 100 MB and more) into the
    output's `public/distros/` (`.output/public/distros/`, on Vercel
    `.vercel/output/static/distros/`) in the `unkernel:distro-images`
    plugin, whose `buildApp` hook runs after Nitro's. That is after Nitro
    compressed its public files and listed its static assets:
    `compressPublicAssets` has no filter and compresses every file whose
    type it does not know as text, and Nitro's static handler (which does
    answer single ranges) would then send the `.br` variant. Such a URL
    never changes content, so it is `cache-control: public,
    max-age=31536000, immutable`, with the strong ETag
    `"<hash>-<size in hex>"`, the same on every server and deploy. A new
    image is a new URL, so a session suspended on the old one is not
    offered (Suspend and resume).
  - The built Node server answers them in `web/server/distros.ts` (a Nitro
    handler for `/distros/**`, reading `../public/distros/` next to its
    `index.mjs`). On Vercel the CDN serves them as static files (its
    `config.json` has the `filesystem` handle before the function's
    `/distros/` route), with its own Range support and ETag; the
    `/distros/**` route rule adds CORP, and `unkernel:distro-images` adds
    a route in the `hit` phase (a request a static file answered) that
    sets the immutable Cache-Control, so a 404 from the function is never
    cached. Checked 2026-11-19 in the build output only, not on a
    deployment.
  - The dev server answers `/distros/<name>.erofs` itself (the
    `unkernel:kernel` plugin's middleware; Nitro's dev handler answers
    public files br-compressed, in full and without Range support) from
    the files the list names, wherever they are. A local image is rebuilt
    in place, so these plain names are `cache-control: no-cache` with an
    ETag from size and mtime. The SDK's opening request revalidates (a 304
    while the image is unchanged); its other requests take the browser's
    cached copy anyway (`force-cache` ignores `no-cache`), and after a
    rebuild their old ETag fails the check against the opening one, so
    they are fetched again (below). The list's sizes are read again when
    an image changes (on the next page load). Earlier dev servers linked the images into
    `web/public/distros/` (gitignored); that directory is unused, and in
    Nitro's `ignore`.
  - What the SDK asks of the server (js/core/block.ts `HttpBase`): it
    opens an image with one Range request for its first 256 KiB with
    `cache: "no-cache"` (the one request that revalidates), then reads the
    prefetch the image's distro header names (Alpine: the whole image, one
    plain GET; Debian: one streamed Range request of its first 4 MiB), the
    background tier it names once the boot is quiet (Debian: the warm set,
    apt's files, from 4 to 27 MiB, in 4 MiB Range requests one at a time),
    and lazy and read-ahead ranges (256 KiB-aligned; read-ahead up to 4 MiB),
    all `cache: "force-cache"`, comparing each response's
    ETag with the opening one's and fetching a mismatch again with
    `cache: "reload"`. So every response for an image, 200 and 206 alike,
    must carry the same strong ETag, be cacheable (never `no-store`) and
    not be content-encoded (a 200's Content-Length is checked against the
    image's size).
  - The dev middleware and the Node handler share `web/server/range.ts`:
    no compression, 200 for a request without Range, 206 with
    Content-Range for one range (a malformed or multi-range header gets
    the whole file), 416 with `bytes */<size>` past the end, one ETag per
    image on every response (a rebuilt image changes it, and the SDK's
    strict `HttpBase` then refuses reads instead of mixing two images),
    If-None-Match before Range (RFC 9110: a cached range revalidates with
    a 304), If-Range, COOP/COEP/CORP, and 404 (`no-store`) for anything
    else under `/distros/`. Vercel's CDN sends its own ETag; whether it is
    the same on a 200 and a 206, and across its edges, is not checked (a
    differing one costs a refetch, never a mixed image).
  - Measured 2026-11-19, headless Chromium (Playwright's build), one
    profile, the same load twice, `?data=0`, to the prompt: on the built
    Node server Debian made 20 requests, 18.9 MiB, the first time (prompt
    2.2 s); the second time only the opening request reached the network
    (a 304, 423 bytes) and 19 came from the HTTP cache (prompt 0.52 s);
    Alpine 2 requests, 4.1 MiB (0.36 s), then 1 on the network (304) and 1
    from the cache (0.34 s). The dev server: the same counts (Debian's
    second load 0.67 s).
- `web/src/sdk.ts` imports `js/core/index.ts`, `js/web/memory.ts` and
  `js/web/platform.ts`, not `js/web.ts`, whose own bundled kernel would
  become a second 10 MB asset. Its `kernelUrl` is a hashed Vite asset,
  which the Node server sends precompressed (br, zstd, gzip). Compressed
  responses have no decoded length, so there is no download percentage.
- `vite.config.ts` keeps the dev server from watching `.output/`,
  `.vercel/`, `kernel/release/` and `kernel/page/`: a page build rewrites
  `index.html` there, which would reload an open dev page and end its VM.

## Rules

- Settings live in localStorage `kw.settings` (config.ts `SETTINGS_KEY`:
  the parameter names and values, only those that differ from the
  defaults). Reboot saves the options there and loads the bare URL; a URL
  parameter of the same name overrides the saved one for that load (the
  browser tests use that), and the page never writes the URL (where
  localStorage refuses, Reboot puts them in the URL instead). Every
  setting except `?shared` has a control under Options in the System tab
  (`Options.tsx`, the store's `options`, `nextSettings()`); `?simulate`
  and `?showcase` are URL only. A new setting needs a control too. The
  desktop test checks the mapping. The
  fields are controlled, and also read by native listeners on the form,
  because React drops change events for a value set from script (the test
  does that).
- `window.KW` is what the browser tests read, together with the element
  ids: `#bar-win-N` (window N), `#bar-new`, `#bar-display`, `#bar-log`,
  `#bar-errors`, `#status` (its CSS `color` turns red on an error) and
  `#status-label`, `#panel` (class `open`), `#confirm`. Keep them working.
- Safe areas are the CSS variables `--st`, `--sr`, `--sb`, `--sl` (style.css). On iOS,
  `--sb` is three quarters of the bottom inset: the status line's background reaches the
  bottom edge, its contents sit that far above it, and it moves its ends in by `--sc`
  (half the bottom inset) for the round corners. While the on-screen keyboard is up
  (`App.tsx` sets `kb` on the root when the visual viewport is well below the layout
  viewport, so on iOS) both are 0 and the status line is hidden. In an iOS home screen
  app `--st` is 24 px more than the top inset: iOS fades the page's top 20 px or so
  there.
  On macOS outside fullscreen, `main.tsx` sets `mac-window` on the root and `--sc` is
  8 px, for the window's round bottom corners.
  In a home screen app (standalone) `App.tsx` sizes `#app` to the layout viewport's height
  unless the keyboard is up (the visual viewport can stay short after it closed). The
  status bar style is `black`, not `black-translucent`: with that, iOS 26+ makes the
  viewport shorter than the screen by the status bar and shows nothing below it (WebKit
  bug 301108). iOS reads the style when the app is added to the home screen.
- An unknown or failed boot step must end in `ui.fail(...)`, so the
  indicator turns red and the panel opens. The page must never stay blank.
  `index.html` installs `error`/`unhandledrejection` handlers first and
  reports the page module if it has not run after 8 s; `main.tsx` imports
  the boot chunk only after `checkSupport()` passed. A missing feature, a
  module that fails to load, a 404, a failed allocation, a panic or a trap
  all end there.
- Memory: the default is the SDK's `autoMemoryMiB()` (512 MiB on desktops,
  256 on phones, less with a low `navigator.deviceMemory`); if the browser
  refuses the allocation the runtime retries with
  `DEFAULT_MEMORY_FALLBACK_MIB` (3584 down to 64 MiB, `js/web/memory.ts`).
  Alpine boots in 48 MiB.
- Keyboard shortcuts (`shortcuts.ts`): Ctrl-A is a prefix as in GNU
  screen, and ⌘A too on Apple devices (it takes nothing from the guest). Digits
  are windows, as in screen and tmux (also Ctrl-Shift-digit, which
  terminals and browsers leave unused), so new shortcuts use letters. New
  window is n or c (as in tmux); the launcher is o, also ⌘K on Apple devices
(a `meta` code in COMMANDS; Ctrl-K is readline's kill-line, so not that
elsewhere) and Ctrl-Shift-O; Copy diagnostics is y after the prefix
  and c inside the dialog. The listener is
  on window in the capture phase and is added before display.ts's, so the
  shortcuts work while a program holds the evdev keyboard; key-ups always
  pass, so a Ctrl the guest saw go down comes up.
- The dialog is modal and keyboard-usable (`aria-modal`, `inert` while
  closed, ARIA tabs, focus trapped and returned). Options are real inputs,
  so keyboards and screen readers work on them. Questions use `ui.ask()`,
  a native modal `<dialog>`, never `confirm()`; it releases pointer lock
  first.
- Display and input: the mode offered to the guest is the stage size in
  CSS pixels (turned when the rotate chip is on), and the canvas is scaled
  to fit. While a program has the evdev keyboard open, keys go to it and
  not to the terminal. With the tablet open the pointer goes there as
  absolute positions and nothing locks; this wins when both mice are open.
  Otherwise a click with the relative mouse open takes pointer lock. Phone
  keyboards send no usable keydowns, so a hidden input's value is diffed
  against a sentinel and sent as US-layout key presses. Pointer positions
  under rotation go through `unturn()`/`localPos()` (Display.tsx). Touch
  layout choices are in localStorage (`kw.*`).
- Terminal windows (`windows.ts`): 1-9 are `vm.spawn()` sessions (js.md),
  each its own wterm. Output is read all the time, shown or not, since an
  unread `Pty` blocks its programs; the reader takes the next chunk only
  after `write()` returned and yields a task (a MessageChannel, which
  background tabs do not throttle) every 16 ms or 256 KiB. `KW.windows`
  is their API. Checked by hand only (no browser test yet).
- Worker mode (the default where the page is cross-origin isolated, else
  off; `?worker=0` / `?worker=1` pick; implied by several CPUs) boots through the SDK's worker mode (js.md):
  the page compiles the kernel and passes the `WebAssembly.Module`; disks
  and the network are specs built in the worker. The data disk in worker
  mode follows data-disk.md (Persistence in the browser). `KW.kernel` and
  `globalThis.kernel` stay unset, so the browser tests (whose
  `page.type()` uses `kernel.sendInput()`) run inline only: lib.mjs
  `goto()` adds `?worker=0&cpus=1` unless the URL has them. A default
  worker (no `?worker=`) that does not start (a `support` BootError, or
  no report within 20 s) reloads once on the page's thread
  (`bootUpOnce(..., inline)`, sessionStorage `kw-inline-once`); every
  other way an asked worker can fail ends in `ui.fail`.
- Sound is an AudioWorklet fed by postMessage, because the kernel calls
  the import from a busy main thread; scheduled buffers are the fallback
  where there is no secure context. Checked by hand only.
- Every response carries COOP/COEP. A secure context is therefore
  cross-origin isolated, which worker mode's shared transport needs (the
  kernel's own memory is not shared). Anything cross-origin that the page
  loads must send CORP (WebSockets are exempt).
- The guest network is Wisp only. A page served from an origin outside the
  Wisp server's allow list needs its own Wisp server (js.md). A `ws://`
  server is blocked as mixed content on an `https://` page.
- The distro (above): `?distro=<name>` (default `debian`, else the first
  image; an unknown name boots the default, with a warning line, a toast,
  the Environment tab's Distro row and the option's note; `none` attaches
  no image: the base shell). Its option is the Distro radios
  (`#opt-distro-<name>`, `#opt-distro-none`, `#opt-distro-note`). Inline,
  boot.ts opens the image with `openDistroDisk()` while the kernel
  downloads, so the resume check sees the snapshot's disks (`[distro,
  data]`); worker mode passes the URL. The image is the read-only
  `/dev/wda`, the data disk `/dev/wdb`. The bundle's own command line is
  used unless `?append=` gives one (`?root=` appends `kw.root=`). Once
  user space runs, boot.ts reads `/run/kw-base` (guest/base/initramfs/init)
  for the Distro and Root rows, About (the image id) and diagnostics'
  config line (`distro=`, `image=`). Where a feature or text is Alpine's
  (apk, wget), it is gated on `cfg.guest === "alpine"` (Rules,
  Launcher). Failures: an image that does not open (404, a
  server without Range, not erofs/ext4) is `ui.fail` (kind `distro`, with
  a hint); a read that fails later (the image changed or the server
  stopped; the guest gets EIO) is a non-fatal `KW.report`; the base's
  base shell (`unkernel base shell (...): why` on the console) is a
  warning row and a report. Checked 2026-11-19 with headless Chromium (a
  scratch script, not in `web/test/`) on the built Node server and the dev
  server, from a scratch build of the current sources: both distros, the
  switch through Options and Reboot, per-distro changes on the data disk,
  `?data=0`, `?worker=1`, `?cpus=2`, `?root=initramfs`, `?distro=none` and
  an unknown name, suspend and resume (inline and worker) and the refusal
  across distros, the data disk reset (`KW.resetData()`), and the
  failures above (404, no Range, a changed ETag, by request interception).
  To the prompt, Debian 0.9 s and Alpine 0.3 s on the Node server with a
  cold cache (caching above).
- apk index prefetch (`apk.ts`, described at its top): on the alpine
  image only. Once user space
  runs, the page pushes the guest's missing or stale APKINDEX files into
  `/var/cache/apk` through `vm.exec()` (as root: `execAsRoot()`, sudo.ts), so apk skips its own index download.
  That covers the enabled repositories and the lazy ones in
  `/etc/kw-apk-lazy` (community), which kw-apk-install reads before it
  enables one (kernel/guest.md). It fetches them as plain http over its own Wisp connection (the mirrors
  send no CORS headers; apk checks the signature on every load) and keeps
  them in the Cache API (`kw-apk-index-v1`), revalidated after 1 h. The
  pushed file's mtime is the time the mirror last confirmed it. Off with
  `?net=0`.
- `~/README` (intro notes) comes from the image, not the page
  (kernel/guest.md); its section on the page names the page's shortcuts
  and options: keep them in step with the page.
- The safe-mode explanation comes from watching the console for
  `kw-overlay: SAFE MODE:` (`boot.ts`, see data-disk.md): the base's check
  of the root with the data disk's changes failed, so this boot runs the
  plain image on a tmpfs upper; the changes stay in
  `/data/distros/<name>/upper`, and every boot checks them again. The
  panel note (`data-safe-note`), a toast and the Root row say so, with
  `kw-overlay status` and `kw-overlay discard`. `?root=initramfs` (the
  Safe mode button) is the same for one boot by choice.
- A guest `reboot` (halt code 2) reloads the page once the last data-disk
  save has committed, at most 3 times a minute per tab (sessionStorage
  `kw-auto-reboot`); then the page stays halted and says why.
- Kernel messages go to the Kernel log tab; during boot only the newest
  shows on a transient line, and IMPORTANT ones (`js/core/console.ts`) are
  written in full. Once user space prints, "Started Linux" (the kernel until
  it runs `/init`), "Started Alpine" (the base mounting the image and the
  distro's init; "Started the base shell" without one), the "Booted
  in" summary, two notes (the repository as an OSC 8 link, and how to
  open the demo launcher; not on a resumed session), with Pip from the
  logo (`assets/logo.svg`) in truecolor half blocks to their left when
  the terminal is wide enough, and the buffered
  user-space output follow; nothing is scrolled away or erased. The desktop test checks the order.
- wterm (`@wterm/dom`, Apache-2.0; xterm.js was dropped because its touch
  scrolling had no momentum) renders rows as DOM text, and `#term` (and
  each `.term-win`) is itself the scroll container, so `#term` must not
  set `overflow`. When it gets shorter while scrolled to the bottom,
  App.tsx puts it back at the bottom before wterm refits (wterm would
  otherwise show the prompt behind the keyboard). React renders `#terms`
  and `#term` once and never touches them again. wterm takes the row
  height from `--term-row-height`, so `setTermFont()` sets both together.
  `KW.screenText()` reads its core directly, because `readText()` is async.
- Phones never zoom the page: a pinch sets the font size, two-finger
  touchmoves and Safari's `gesture*` events are cancelled (iOS ignores
  `user-scalable=no`), and wterm's hidden textarea is 16 px, because iOS
  zooms on focusing a smaller field.

## Several CPUs

The CPUs option (System tab, Options, the `#opt-cpus` slider; `?cpus=N`,
config.ts) boots the SMP kernel on N CPUs (kernel/smp.md; js.md, CPU
threads). Default in worker mode where the page can boot the SMP
kernel: the suggested count (`cfg.cpuDefault`); else 1, the UP kernel.
`?cpus=1` is the UP kernel (the same files and code paths as before
the option). The Worker thread and CPUs options are saved only
where they differ from these defaults. It applies on Reboot, like the
other options.

- Choices: 1, 2, 4, 8 and 16 up to `navigator.hardwareConcurrency`, and
  that count itself (the kernel's limit is 16, `NR_CPUS`), plus the suggested count,
  hardwareConcurrency / 2 up to `SUGGESTED_CPUS` (4 on desktops, 2 in
  Firefox, none on phones until measured; config.ts, with the
  /profile.html numbers behind it), marked
  "(suggested)" (none below 4 threads, and none in WebKit: Safari 27.2 ran
  parallel work slower on every added CPU, 2026-11-19; `webkitEngine()`).
  A count past the suggestion (past one where there is none) is there to
  try: selected, the slider, its value and its note turn red (`Stop.warn`).
  Half the host's threads stay free for the page, the browser and other
  tabs: a guest CPU whose thread the host deschedules stalls the CPUs
  that wait for it (status.md, SMP, under host load). A larger `?cpus=` is
  capped at the thread count.
- `smpBlocker()` (config.ts) disables the slider, with the
  reason under it (`#opt-cpus-note`) and in the Environment tab's
  "Guest CPUs" row: no SMP kernel in the page's bundle (`kernelSmpUrl`
  null: a bundle without the SMP patch), no cross-origin isolation (a plain-http
  LAN page), no Web Workers or no `Atomics.waitAsync`
  (`webCpuBlocker({ worker: true })`), or one host thread. Such a load
  with `?cpus=N` boots on one CPU as usual and says why.
- With several CPUs, boot.ts loads `kernelSmpUrl` instead of `kernelUrl`
  (streaming compile; the UP bundle is not fetched) and boots in worker
  mode (`cfg.worker` is set, not `?worker=1`; Options shows the Worker
  thread box ticked and disabled, keeping its own value for one CPU), with
  `cpus`; the kernel worker starts the other CPUs as nested Web Workers.
  The download starts only after the suspended session was offered
  (below), since the answer picks the kernel. The SMP bundle is a hashed
  `/assets/` file like the UP one: the service worker (scope `/vm/`) never
  sees it, and the HTTP cache keeps each file on its own.
- `/profile.html` (testing.md, Profiling CPUs and worker mode) measures
  the configurations the defaults choose between; `SUGGESTED_CPUS`
  carries the numbers it is based on.
- Falling back: a failed SMP download or compile, or a `createKernel()`
  that rejects (the worker, its JSPI, the shared memory), calls
  `bootUpOnce()`: it stores the reason in sessionStorage `kw-up-once` and
  reloads; that load boots on one CPU the usual way (in worker mode
  where that is the default) and shows the reason (`cfg.smpWhy`: the Guest CPUs row,
  the CPUs note, diagnostics). The saved CPUs setting stays, so the next
  load tries again. If sessionStorage refuses, the failure is reported
  instead (no reload loop). A kernel worker that cannot start CPU threads
  (`webCpuBlocker()` there) runs the SMP kernel on one CPU: the Guest
  CPUs row warns, from `stats().cpus`. A failure after the kernel started
  (a CPU's trap or fatal error) ends the session like any other, with a
  hint to set CPUs to 1.
- The console with several CPUs: every CPU's output comes through the
  console ring the page itself reads (js.md, CPU threads), not through
  the kernel worker, so the terminal gets a few hundred chunks for
  `seq 1 200000` instead of one message per write, and output from a task
  on CPU 1 is not held up while CPU 0 runs user code. Headless Chromium,
  `?cpus=2` (2026-11-17, before, then after): `seq 1 200000` on CPU 1
  37.7-38.4 s and 2.8 s (CPU 0: 2.3-2.5 s); echo of a shell on CPU 1
  while CPU 0 spins, median 9.4 and 0.57 ms; lines printed in turn on
  CPUs 0 and 1 in order either way; the default load unchanged.
- No Suspend: the SMP kernel cannot park. `KW.suspend` stays unset (so
  the status line has no pause icon), the dialog footer has no
  `#suspend`, and Ctrl-A z says why. A suspended session (always a UP
  one) is offered before the download: "Resume on 1 CPU" reloads once on
  one CPU (`bootUpOnce()` with `kw-resume`) and resumes it; "Boot on N
  CPUs" boots SMP and, when the session has a data disk, deletes it (that
  boot changes the disk), else keeps it.
- The boot summary says "on N CPUs"; diagnostics' config
  line has `cpus=`.
- Checked in headless Chromium (Playwright's build, the built page from
  the l2 patch bundle, 2026-11-17, a scratch script, not in `web/test/`):
  the default load fetched only the UP bundle and ran on one CPU; `?cpus=2`
  and `?cpus=4` fetched only the SMP bundle, `nproc` gave 2 and 4, a
  terminal window, glimmer's test pattern, key and sound through worker
  mode worked, the JIT compiled on every CPU, and n parallel awk loops
  took 1.14x (2 CPUs) and 1.20x (4) the time of one; a plain-http LAN
  load disabled the option and booted on one CPU; a blocked SMP download
  reloaded on one CPU; a UP session resumed from a `?cpus=2` load ("Resume
  on 1 CPU") and was deleted by "Boot on 2 CPUs"; a page from the newest
  release (no patch) showed the option disabled and booted UP. Also the
  Vite dev server (nested worker from source).
- Checked by hand on a deployed build (2026-11-17): several CPUs work in
  desktop Chrome, in Firefox and on iOS. Desktop Safari and Android: not
  tried.

## Suspend and resume

Not with several CPUs (above). Suspend (Ctrl-A z, `z` in the dialog, the dialog footer's `#suspend`, the
status line's pause icon `#bar-suspend` while the system runs, or
`KW.suspend()` without asking) saves the running machine with the SDK's
`snapshot({ stop: true })` (js.md, Snapshots), inline or in worker mode, and
stops it. The page then shows "Suspended", the store's `suspended` is set,
and a Resume card (`#resume`, Overlays.tsx) sits at the bottom of the stage,
with a play icon `#bar-resume` in the status line. Resume (`ui.resume()`)
sets sessionStorage `kw-resume` and reloads the same URL; the load reads it
once and resumes without asking. A plain load offers to resume (`ui.ask`
with Resume and Boot fresh) before the kernel starts.

- `session.ts` keeps one session in IndexedDB `kwsnap:session-v2`, its own
  database (the first open on a page deletes `kwsnap:session-v1` and any
  other older version, unawaited): `meta` (time, the page's kernel URL, the banner, the device
  options, the disks' snapshot state, the console's last 64 KiB) and
  `bytes` (the `encodeSnapshot()` Blob), written in one transaction. It
  never opens `kwdisk:kwdata-v1`.
- Offered only when the kernel URL (a hashed asset: another release cannot
  resume), the distro image's URL (`meta.distro`; a build's names its
  content, so another build of the same distro cannot resume) and the device
  options (Display, Sound, Network, Data disk) are
  as saved, and inline when `snapshotDiskMismatch()` passes on the opened
  data disk. A disk that changed makes the session useless, so it is
  deleted then. In worker mode the worker checks the disk; a tab without
  the disk lock is not offered it. Any refusal (a disk, a device, another
  kernel build) boots fresh with a warning line and a toast. Boot fresh
  deletes the session when it has a data disk (the fresh boot changes the
  disk), else keeps it. A resumed or refused session is deleted.
- On resume the terminal shows "Resumed the session suspended …", the
  summary, then the console's saved tail (the guest redraws nothing).
  Terminal windows 1-9 and network connections do not survive (their vsock
  and TCP ends are reset).
- No save when the tab goes away: a save needs the kernel to park, the
  memory copied and encoded (about 150 ms with the CLI, 2026-11-15) and
  about 30 MiB committed to IndexedDB, and a closing page has no
  guarantee that a transaction it starts commits. A snapshot without `stop`
  when the tab is hidden would not help: the guest writes `/data` within
  seconds, which makes it unrestorable.
- Checked by hand only (no browser test).

## Service worker and updates

The page's one service worker (`public/vm-sw.js`, registered by `sw.ts`)
has scope `/vm/`, in dev and in a build alike, and serves only the guest
preview (below). It does not control the page: `/`, `/assets/` (the
kernel among them) and everything else the page loads go to the network
and the HTTP cache, so a reload always runs the newest deploy. There is no
offline copy: a cache-first page stays old whenever caching a new build
fails.

- Its own updates: `register()` with an unchanged script URL does not
  look for a new one, and loads of `/` are outside the scope, so the
  browser's own check on navigation never runs. `sw.ts` therefore calls
  `registration.update()` on every load (the first `serviceWorker()` call,
  when the preview attaches) and again when the tab is shown after an
  hour. `/vm-sw.js` is `no-cache` and registered with
  `updateViaCache: "none"`. A new script activates at once (`skipWaiting`,
  `clients.claim`), so the relay's messages must stay compatible.
- Legacy scope `/`: earlier builds registered the same script at `/` and
  answered `/` and `/assets/` from the Cache API `kw-app-v1`. The browser
  checks that registration's script on each navigation to `/`, so it gets
  the new `vm-sw.js`, which then answers nothing outside `/vm/` (as at
  any scope), deletes `kw-app-*` caches on
  activation, and (`LEGACY` in the worker) answers the old page's
  `{t: "kw-check"}` with `update`,
  so that page's status line offers a reload. The load that brought the
  new script still ran the old cached page; the next one comes from the
  network, and its `boot.ts` calls `dropLegacyScope()`, which unregisters
  `/`. Activation never deletes other caches (`kw-apk-index-v1` is apk.ts's).

## Guest preview

A web server running in the guest (say on port 8000) shows in a panel
docked right of the stage (`Preview.tsx`), or in a tab of its own, at
`/vm/<vmId>/<port>/<path>`. The vmId is random per booted kernel
(`preview.ts`). Ways to open it: Ctrl-A p (it opens on the last port, or
8000; pressed again it hides or shows the panel), the Preview section in
the Guest tab, the status line's globe icon on the right (`#bar-preview`,
which hides and shows it; the port is in its tooltip), `KW.preview.open(port)`, and in the guest
`open` or `xdg-open http://localhost:<port>/<path>` (`open.ts`, after a confirm). On wide screens the panel takes part of the
stage's width, so the terminal (and the display offered to the guest) gets
narrower; its left edge sets the split (localStorage `kw.previewSplit`,
default 40%) and `[□]` fills the stage. On narrow ones (under 720 px) it
fills the stage. While it covers the stage it is a view like a terminal
window or the display: picking one of those (`windows.ts` `select()`,
`toggleDisplay()`) hides it, and the status line marks only the globe as
current. Hidden, the terminal gets its width back. It has a port field, reload,
and a link that opens the URL in a new tab. It is no URL parameter, so it
has no Options control.

- Relay: `public/vm-sw.js`, a plain script served at `/vm-sw.js`, outside
  the TypeScript build: the page's one service worker (scope `/vm/`;
  Service worker and updates). The relay is stateless, because
  browsers stop idle service workers. For each request it posts
  `{t: "kw-vm-fetch", vmId, port, method, path, headers, body}` (path
  includes the query, body is an ArrayBuffer or null) with a
  MessagePort of its own to every window client that is not under `/vm/`
  (`clients.matchAll({type: "window", includeUncontrolled: true})`). The
  page whose vmId matches answers `accept` at once, and other tabs
  ignore the message. Then come `head` (status, statusText,
  headers), `chunk` messages (transferred ArrayBuffers), and then `end`, or
  `error` (an HTTP status before `head`). The worker sends `more` when its
  body stream pulls and `cancel` when the stream is cancelled. The page
  may send 4 chunks ahead of `more`. Transferable streams are not used,
  because Safari lacks them. With no `accept` within 5 s the worker
  answers 502 with a short text. If the guest sends no head within 60 s
  after the accept, it answers 504. `/vm/<id>/<port>` without the slash
  gets a 308 to the slash.
- Page side (`preview.ts`): boot.ts calls `attachPreview(vm)` once the
  kernel runs, and `attachPreview(null)` at exit; requests then get 503. The
  first call registers the worker (`sw.ts`), only where `navigator.serviceWorker`
  exists (secure contexts). The window waits until the worker is
  active. It does not use `navigator.serviceWorker.ready`, which never
  resolves, because the scope `/vm/` does not control the page. Requests go
  to `vm.fetch("http://localhost:<port><path>", {method, headers, body,
  redirect: "manual", signal})` (the SDK's, js.md, which follows no
  redirects and does not decode bodies). preview.ts needs only its
  `GuestFetcher` interface. At most 8 relayed requests run at once and the rest queue,
  because each guest connection forks a server process. Request headers
  lose hop-by-hop ones and `host`/`content-length`. `accept-encoding` is
  `identity`, because the browser does not decode a synthesized response.
  `origin` becomes `http://localhost:<port>`, so CSRF checks see the guest's
  own origin.
- Response headers: the worker drops hop-by-hop headers, the guest's own
  COOP/COEP/CORP, and Set-Cookie (a synthesized response cannot set
  cookies). It adds `Cross-Origin-Embedder-Policy: require-corp` and
  `Cross-Origin-Resource-Policy: same-origin`. A document in the
  isolated page's iframe needs a COEP. `credentialless` would also
  let a guest page's CDN assets load in Chrome and Firefox, but Safari
  does not implement it and would block the iframe. With require-corp a
  guest page's cross-origin subresources load only if they send CORP or
  CORS. A redirect to `/x` or to `http://localhost:<port>/x` is rewritten
  under the prefix.
- Root-relative URLs: the worker answers only `/vm/<id>/<port>[/…]`.
  Nothing outside it is relayed, so a preview document's `/style.css`
  reaches the unkernel server, not the guest: guest pages must use
  relative URLs. Navigations outside `/vm/` (a link to `/about`) reach the
  server, which sends the page, and `main.tsx` sends them back under the
  prefix (`previewEscape()`: the iframe's `data-kw-preview`, or in a tab the
  referrer) instead of booting a second kernel.
- Server: `/vm/**` reaching the server (a shift-reload bypasses the worker,
  or the worker is not installed) gets a 503 page from `server/vm.ts` that
  says the preview needs the page open, not the app. Its link to `/` is
  `rel="noreferrer"`, so `previewEscape()` does not send it back.
  `/vm-sw.js` is `no-cache`, and the worker registers with
  `updateViaCache: "none"`. In `pnpm dev`, Vite serves `public/` and Nitro
  the handler; both carry COOP/COEP.
- Limits: same-origin and trusted content only, since the guest's pages can
  script the unkernel page (`parent.KW`). A sandbox without
  `allow-same-origin` would take the iframe out of the worker's control. A client-side
  router sees the `/vm/<id>/<port>` prefix in `location`. WebSockets and
  Vite-style HMR bypass service workers, so they do not reach the guest.
  Cookies are not set. A tab on the URL works only while the page that
  owns the vmId stays open, and a reload gives a new vmId. There is no
  back-pressure beyond the 4 chunks ahead plus one per pull. A long
  stream may be cut when the browser stops a worker whose event runs for
  minutes. Checked by hand only, plus a Node harness of the
  relay against a fake `vm.fetch`. No browser test.
- Trying it by hand: the image's busybox has no httpd. In a terminal
  window, run `sudo apk add busybox-extras`, then `mkdir -p /tmp/www && echo hi >
  /tmp/www/index.html && httpd -f -p 8000 -h /tmp/www`. Or run `sudo apk add
  python3`, then `cd /tmp/www && python3 -m http.server 8000`. Then Ctrl-A
  p, and "Go" after changing the port.

## Launcher

The status line's first item (`❯`, `#bar-launcher`), ⌘K on Apple
devices, Ctrl-Shift-O or Ctrl-A o open the launcher (`#launcher`, `Launcher.tsx`, the store's `launcher`):
an overlay over the whole page in the manner of macOS Launchpad, the page
blurred behind a grid of tiles (glyph and gradient from the demo) and a
search field. The focus stays in the field (tiles take none), so
display.ts never routes its keys to a program holding the guest's
keyboard; arrows select, Enter runs, Esc clears the search, then closes; a
click on the backdrop closes. On touch devices the field is not focused.
A demo's `icon` is a glyph or a pictogram as inline SVG markup (static
strings in the demo file, set as inner HTML): project logos from Simple
Icons (CC0, the slug in a comment), else the project's own mark from its
site (the source in a comment), crafted ones otherwise.
After the demos comes a gray System tile that opens the dialog
(`PANEL_TILES`), which works in any state.

The demos are one file each in `src/demos/`, listed in order in
`src/demos/index.ts`; `launcher.ts` runs them. The page ships no assets for
them, so a demo is text only (`Demo` in launcher.ts): `files` written under
its directory (`~/demos/<id>` by default) with one `vm.exec()` each (or a
function that loads them at launch with a dynamic import, which keeps
their text out of the page's main chunk), plus
a generated `run.sh` there for the running distro (the `packages` it
names for that distro, `{ alpine, debian }`, not yet installed: on Alpine
`/etc/kw-apk-enable` when the demo sets `community`, then `apk add`; on
Debian `apt-get install`, again after `apt-get update` when the baked lists
name a version the mirror dropped; then the `commands`, each printed
before it runs, under `set -e`). The files, run.sh and the window are the
session's user's (`user` on the distros): run.sh starts with `SUDO_SH`
(`sudo.ts`) and runs the package manager, and the commands a demo writes
as `$SUDO cmd` (nginx's server, PostgreSQL's `start.sh`, Ubuntu's
chroot, sshfs's mount), with sudo, printed as `sudo cmd`; where it runs as
root (the base shell, which has no sudo) both are plain. A demo directory
outside the user's reach (nginx's `/srv/nginx`) is made and handed to the
user with sudo, and a file the user cannot write (PostgreSQL's
`createcluster.d` file under `/etc`) is written with sudo. A demo runs only on the distros its
`packages` name; its scripts handle what else differs (Doom's and
Ubuntu's, with no `packages`, run on both). A new terminal
window named after the demo runs `sh -lc` with a wrapper in place of the
login shell: `cd <dir> && ./run.sh`, then `exec` the login shell, so the
window stays to edit and rerun (an INT trap keeps the wrapper alive through
Ctrl-C). Typing the command into a fresh shell lost the start of the line,
because the login discards input typed ahead of its prompt. The preview opens once the
guest answers http on the first of its `ports`. The distros' nginx default
site also listens on `[::]:80`, which fails in the guest (no IPv6), so the
nginx demo replaces it. A demo's files are text in its own file: Doom (`web/src/demos/doom.ts`) carries the `fbdoom` script (fbDOOM built in
the guest with tcc, on `/dev/fb0` with evdev input and `/dev/dsp` sound,
installed in `~/.local/bin` and building into `~/.local/share/fbdoom`; the
first run took 22 s to the first frame, a later one 0.2 s, 2026-11-18) and
its patches to fbDOOM as template literals, and these GPL-2.0-or-later texts keep their license
(the script's SPDX header) inside the MIT bundle. Files with absolute paths land outside the demo directory, and
files from an earlier launch are never removed. A demo's `downloads`
(url, SHA-256, size, guest path, an optional `unless` shell test) are
fetched by the page before its window opens (`download.ts`, described at
its top): the sites send no CORS headers and the page is cross-origin
isolated, so it speaks plain http over its own Wisp connection, as apk.ts
does, follows redirects as http (a site that redirects to https only
fails; a download with `cors`, for a site that sends
Access-Control-Allow-Origin such as releases.fx.sh, is a direct `fetch()`
instead), checks the SHA-256 and keeps the file in the Cache API
(`kw-files-v1`), then pushes it with one `vm.exec()` (through a `.part`
file, size checked). It skips a file that is in the guest already at that
size, or whose `unless` passes in the demo's directory. A failure is a toast
and a log line, not fatal, so the demo's script checks the file itself and
downloads it when it is missing (Ubuntu does). On 2026-11-15 (Node, the
default Wisp server) the riscv64 Ubuntu Base tarball (31 MB) took 1.5 to
4.4 s to fetch and 0.2 s to push; the arm64 26.10 one (35 MB) took 0.3 s
to push (Node SDK, 2026-11-18). A demo with `hidden` set is left out of the launcher. A demo runs once at a time: picking one whose window
is open (a dot under its tile) shows that window. A demo whose `needs`
(display, net, sound) the page's options rule out is dimmed, with why; so
is one whose `packages` leave out this boot's distro.
Failures are toasts. Checked by hand only.

Every demo's run.sh, as the launcher writes it, was run on the aarch64
guest through the Node SDK on 2026-11-18: a fresh data disk per demo, 512
MiB, the files written with `vm.exec()` and run.sh in a pty session (the
window's command without the wrapper), the host's network instead of Wisp,
a display or sound card where the demo needs one, and the Ubuntu tarball
pushed as `downloads` does (a scratch harness, not in the repository).
Each reached its working state: the
servers answered over `vm.fetch()` (nitro's echo POST), postgres's `select version()` said aarch64, glimmer and Doom drew
frames, radio and speak played sound, sshfs mounted Rebex's server.
Seconds from run.sh's start, the `apk add` step (indexes and packages
over the host's network) first, then the time to the working state:
htop 1.6/1.7, tmux 1.8/2.6, mc 2.6/3.0, Neovim 6.8/7.7 (community), Git
2.8/4.9 (clone 1.6 s), sshfs 2.9/4.6 (mounted, tour done), nginx
1.8/2.1, Nitro 5.9/39.4 (upm install 16 s, `nitro dev`
14 s), PostgreSQL 5.7/19.6 (initdb and start 13 s),
SQLite 1.7/2.9, Valkey 2.1/3.3, radio 1.7 (sound about 1 s after a
station is picked), speak 2.4 (the introduction starts at once),
asciiquarium 6.7/6.8 (community), glimmer 0.1 (no packages), Ubuntu 28
(extracting the pushed tarball; 0.2 later, `apt-get update` 28 s in the
chroot), Doom 22 (tcc install, downloads and a 6 s build; 0.2 later).
The REPL and toolchain demos (Claude Code, fx, Bun, Node.js, Python, Go,
Rust) came after that run and have not been through it.
Docker (Debian only: `docker run --rm hello-world` through the image's
docker shim, kernel/guest.md) came later too: with Docker installed, its
command pulled and ran hello-world in 6 s (Node SDK, 1 GiB, data disk, the
host's network, 2026-11-19); the first run adds the shim's install
(about 1 min).

`?showcase` runs `src/showcase.ts` once the guest is up: a
fast, hands-off tour of the demos, leaving out the web servers (described at its top).
Each step shows a caption and launches its demo.
It waits for a process (`pgrep -f`), a pattern on the screen, the display or
the preview, then plays it: keys typed into the terminal, or the evdev
keyboard for glimmer and Doom. Then it closes the demo. A bar along the top
shows progress, and the tour ends on a title card. `?showcase=a,b` runs only
those steps. The tour does not wait: a demo not ready within 30 s is
skipped and logged, as is a step that fails. `?showcase=warm` launches each
demo and waits until it is ready, without captions, so apk, npm and the
Doom build come from the data disk on later tours. `KW.showcase` has
`skip()`, `pause()` and `resume()`.

## Running and deploying

- `pnpm dev`: Vite on port 8080, all interfaces, with the local build once
  `kernel/build.sh all` (or `base` and `distro`) has run, else the newest
  release (The page's kernel and distro images). `pnpm build:web` writes
  `web/.output/` the same way (a build beside the main outputs:
  `KW_KERNEL=<dir>/unkernel.wasm KW_DISTROS=<dir> pnpm build:web`), and
  `pnpm start:web` runs it (port 3000 unless `PORT=`). `pnpm
  typecheck:web` type-checks it.
- On Vercel, Nitro detects the platform and writes `web/.vercel/output`.
  Elsewhere, `NITRO_PRESET=vercel pnpm build:web` produces the same for
  `vercel deploy --prebuilt`. Vercel's build sets `VERCEL`, so it takes
  the newest release: deploy only after a release with this layout
  (unkernel.wasm, distros.json, the images) exists. The images are about
  77 MB of static files (alpine 4.0, debian 72.6 MB).
- A LAN `http://` page is not a secure context: no clipboard API, no
  `deviceMemory`, no Web Locks, and no cross-origin isolation. It still
  works.

## Browser tests (`web/test/`)

Agents run these only when asked. The page is tested by hand with
`pnpm dev` on port 8080, so do not start anything on that port.

`headless.mjs` (`pnpm test:web`: desktop with the JIT compiling and
cross-origin isolation asserted, phone over LAN, nojspi, fetch404, modfail,
lowmem booting to the shell at 128 MiB), `data.mjs` (data disk, overlay root per distro,
safe mode, second tab, export/reset/import) and `net.mjs` (needs the internet), both on
`?distro=alpine` (apk, wget, Alpine's upper layer; `headless.mjs` runs the default image). Shared
code is in `lib.mjs`. They drive Chromium over the DevTools protocol with no
npm dependencies and start the built server (`--dev` starts the Vite dev
server). They use the newest Playwright Chromium in `~/.cache/ms-playwright`
unless `--chrome PATH` or `CHROME=` is given. There is no WebKit test
script.

`open.test.ts` is no browser test: a plain unit test of `src/open.ts`
(`node --test web/test/open.test.ts`).

## Engines

- Several CPUs need, besides JSPI in every worker: cross-origin
  isolation, nested dedicated workers (Chrome, Firefox, Safari 15.5+),
  `Atomics.waitAsync` (Chrome 87+, Safari 16.4+; check Firefox) and
  posting a `WebAssembly.Module` and a shared `WebAssembly.Memory` to a
  worker. Only Chromium has run it (Several CPUs).
- JSPI (`WebAssembly.Suspending`/`promising`) is required: Chrome/Edge
  137+, Firefox 153+, Safari 27+ (every iOS browser uses the system
  WebKit). memory64 is not needed, because the page runs the lowered
  kernel; as of 2026-11 no stable Safari has it.
- Playwright WebKit builds (2336 and 2388) behave like iOS; on 2026-11-13
  they and a real iPhone gave the same hashes with the JIT on and with
  `?jit=0`.
- **Safari 27 runs plain-http pages without a JIT** (2026-11-13, Mac and
  iPhone). On a page that is not a secure context (`http://` at a LAN,
  VPN or proxy address) Safari interprets JS and wasm: kwbench's int
  loop runs at 248 MIPS against 3670 in Chrome on the same Mac. At
  `http://localhost:<port>` or over https it has its JIT. Playwright
  WebKit has no such policy, so it cannot reproduce this. When Safari or
  an iPhone is slow, check the origin first. The page does not warn about
  it.
- JavaScriptCore collects freed JIT modules only when prompted (kwemu.md,
  Collecting freed modules). On an iPhone the JIT row of the Environment tab
  should show `collected` keeping up with `freed`, uncollected modules in
  the hundreds, and `refused` 0. Not yet measured on a phone.
