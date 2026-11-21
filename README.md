<h1 align="center"><img alt="unkernel" src="assets/logo-wordmark.svg" width="400"></h1>

**A real Linux kernel compiled to WebAssembly, with Debian as the default.**

<p align="center">
  <a href="#what-this-fork-adds"><b>Fork changes</b></a> ·
  <a href="#deploy-on-a-server">Deploy</a> ·
  <a href="#-try-it-in-the-browser">Try it</a> ·
  <a href="#-performance">Performance</a> ·
  <a href="#-a-real-kernel">Features</a> ·
  <a href="#-run-it-from-the-terminal">CLI</a> ·
  <a href="#-how-it-works">How it works</a> ·
  <a href="#-benchmarks">Benchmarks</a> ·
  <a href="#-use-it-from-javascript">JavaScript SDK</a>
</p>

## What this fork adds

- **Debian 13 is the default** in the web UI and CLI. It boots with systemd as PID 1. The image includes a minimal Xfce desktop, TigerVNC, Git, GCC, Make, pkg-config, Python and ripgrep.
- **Tailscale runs as a systemd service** after the official installer and `sudo tailscale up`. The image supplies a userspace-networking override and a SOCKS5 listener on guest `127.0.0.1:1055`. Peer traffic uses DERP relays because the browser guest’s network carries outbound TCP.
- **Terminal and desktop from one page.** Choose Terminal or Desktop at boot, then switch views without restarting Debian. The embedded noVNC client talks to TigerVNC over vsock and requests a new guest resolution when the viewport changes. Desktop shortcuts go to Xfce, and the desktop uses the full content area.
- **Portable VM storage.** Choose a local folder before boot to save the guest’s installed packages, files and settings in its `unkernel-data` subdirectory. Another browser can reopen the same folder. IndexedDB and temporary sessions are also available. Use a saved folder from one browser at a time.
- **Disk growth and compaction.** A new folder disk starts at 4 GiB and can be created larger or grown later. Debian resizes ext4 at boot. Unkernel checkpoints accumulated write batches after a clean shutdown when compaction thresholds are met. **Compact now** is available after shutdown. Both the web UI’s **Power off** and `sudo shutdown -h now` take the clean shutdown path. Wait for **Powered off** before closing the tab.
- **Crash recovery.** The folder store publishes completed write batches and commits a replacement checkpoint before pruning old files. Ext4 can replay its journal. A forced Chrome crash test recovered a previously synced file from the same folder in a fresh browser profile. Unflushed writes and interrupted application operations can still be lost or left incomplete. Use **Guest → Data disk → Export** for backups.
- **More guest RAM and configurable zram.** **System → Memory** offers up to 4 GiB with smaller allocation fallbacks. **System → Compressed swap (zram)** defaults to half of usable guest RAM and supports fixed sizes or Off. An experimental Memory64 kernel booted Debian with 6 GiB in Chrome. The regular web build ships wasm32 and offers up to 4 GiB.
- **Live host folder sharing.** **Guest → Shared folders → Share folder…** mounts a selected host folder under `/mnt/shared-<name>` for the current session. Shares are read-only by default. **Allow guest changes** enables writes and deletions on the host. Atomic renames, Unix ownership and permission changes, and links are unavailable. Unmount shared folders before suspending a VM.
- **Faster disk reads over HTTP.** The browser reads ahead for sequential image access. Rebuilt Debian images also fetch commonly used APT and dpkg files after boot, subject to the browser’s Save-Data setting.
- **Fork packaging.** The CLI and SDK fetch packaged distro assets from this fork, and the GitHub release workflow can publish fork assets without publishing to the upstream npm package. The fork includes checks for Debian’s systemd console and folder storage.

## Deploy on a server

This runbook uses an Ubuntu 24.04 or Debian host with systemd, Caddy for HTTPS
and access control, and a local Wisp v1 relay. Replace `vm.example.com` with
the deployment hostname everywhere. Point DNS at the server and allow inbound
TCP 80 and 443 for Caddy and certificate issuance. Keep the Node app and relay
bound to loopback.

The services stay up across logouts and host reboots. Each VM runs in the
user’s browser. Guest RAM, installed packages and saved disks stay on the
user’s device, while the server serves the app and distro images and Wisp
relays guest internet traffic. An open browser session is needed to keep that
VM running. The web app can boot offline with `?net=0`.

### 1. Build the fork kernel and Debian image

Use Node.js 24 or newer, the repository’s pinned pnpm, Zig 0.16.x, and LLVM
22 with the WebAssembly target. Put the tools on the build user’s `PATH`.
The build compiles a patched linker plus the kernels and distro images.
Allow room for the source trees and build outputs. Run it on a separate build
machine if the serving host has limited CPU, memory or disk. [Node.js downloads](https://nodejs.org/en/download) · [Zig downloads](https://ziglang.org/download/) · [LLVM apt repository](https://apt.llvm.org/)

For an Ubuntu 24.04 builder, install the host packages below. Use the matching
LLVM repository for another distro or release.

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl git build-essential cmake ninja-build \
  flex bison bc m4 python3 patch perl e2fsprogs gzip bzip2 xz-utils zstd gpgv
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://apt.llvm.org/llvm-snapshot.gpg.key |
  sudo tee /etc/apt/keyrings/apt.llvm.org.asc >/dev/null
echo 'deb [signed-by=/etc/apt/keyrings/apt.llvm.org.asc] https://apt.llvm.org/noble/ llvm-toolchain-noble-22 main' |
  sudo tee /etc/apt/sources.list.d/llvm-22.list >/dev/null
sudo apt-get update
sudo apt-get install -y clang-22 lld-22 llvm-22
export PATH="/usr/lib/llvm-22/bin:$PATH"
```

Install the pinned pnpm with `npm install --global pnpm@12.14.0` or with your
Node toolchain’s package manager. Use a fresh checkout of the fork revision
you intend to deploy. The kernel bundle and Debian image are generated files
under `vendor/build/`. Run the following blocks from the repository root.

```sh
git clone https://github.com/cnmoro/unkernel.git
cd unkernel
git rev-parse HEAD
pnpm install --frozen-lockfile --prod=false
./setup.sh --check
```

#### Build the kernel bundle first

The build scripts prepare and patch the linker and Linux source as needed.
Build the single-CPU and SMP kernels, the ext4 data disk template, then the
base initramfs and bundle. Debian’s image builder boots this bundle to install
packages into the image.

```sh
(
  set -eu
  export KW_RELEASE=1
  kernel/build.sh kernel
  kernel/build.sh smp
  KW_SMP=1 kernel/build.sh datadisk
  KW_SMP=1 kernel/build.sh base
  test -s vendor/build/bundle/unkernel.wasm
)
```

#### Generate and boot-test the Debian image

Build the Debian EROFS image and its index. The boot check confirms systemd is
PID 1, the desktop tools exist, and the matching kernel exposes zram. Resolve
any failure in this block before packaging the web app.

```sh
(
  set -eu
  test -s vendor/build/bundle/unkernel.wasm
  KW_RELEASE=1 KW_DISTRO_FORMATS=erofs kernel/build.sh distro debian
  test -s vendor/build/distro/debian.erofs
  test -s vendor/build/distro/distros.json
  node guest/tools/vm-run.ts \
    vendor/build/bundle/unkernel.wasm vendor/build/distro/debian.erofs --timeout 120 \
    'test "$(cat /proc/1/comm)" = systemd &&
     command -v systemctl &&
     command -v Xtigervnc &&
     command -v xfce4-session &&
     test -e /sys/block/zram0/disksize'
)
```

To also offer Alpine in the web UI, run
`KW_RELEASE=1 KW_DISTRO_FORMATS=erofs kernel/build.sh distro alpine` before
packaging. This updates the index alongside the existing Debian image.

### 2. Build the production web app from the verified files

Set both build input paths explicitly. The production build packages its
chosen kernel and distro images into `web/.output/`. The final comparison
checks that its hashed Debian asset matches the image you boot-tested.

```sh
(
  set -eu
  bundle="$PWD/vendor/build/bundle/unkernel.wasm"
  distros="$PWD/vendor/build/distro"
  test -s "$bundle"
  test -s "$distros/debian.erofs"
  NITRO_PRESET=node-server KW_LOCAL=1 \
    KW_KERNEL="$bundle" KW_DISTROS="$distros" pnpm build:web
  test -s web/.output/server/index.mjs
  debian_hash=$(sha256sum "$distros/debian.erofs" | cut -c1-16)
  cmp "$distros/debian.erofs" "web/.output/public/distros/debian-$debian_hash.erofs"
)
```

Keep the complete `web/.output/` tree together. It includes the app, both
kernels and the distro images. Rebuild the Debian image when its boot or APT
prefetch layout changes so the served image carries the new hints. For a
separate build machine, archive it with
`tar -C web/.output -czf unkernel-web.tar.gz .` and transfer the archive.
A matching fork GitHub release can also supply the kernel and image assets
for a web build. In that case use
`NITRO_PRESET=node-server KW_LOCAL=0 KW_KERNEL_REPO=cnmoro/unkernel KW_KERNEL_RELEASE="$fork_tag" pnpm build:web`, with `fork_tag` set to the published tag.
Use the fork’s assets so Debian’s desktop, systemd setup and zram are included.

### 3. Run the web app under systemd

Create a dedicated runtime user and copy the production output into a versioned,
read-only deployment directory. Run these commands from the built checkout.
If you transferred the archive, unpack it into the release directory in place
of the `cp` command, using the builder’s revision in the directory name.

```sh
getent passwd unkernel >/dev/null ||
  sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin unkernel
release="$(git rev-parse --short=12 HEAD)-$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -m 0755 "/opt/unkernel/releases/$release"
sudo cp -a web/.output/. "/opt/unkernel/releases/$release/"
sudo chown -R root:root "/opt/unkernel/releases/$release"
sudo chmod -R a+rX "/opt/unkernel/releases/$release"
sudo ln -sfn "/opt/unkernel/releases/$release" /opt/unkernel/next
sudo mv -Tf /opt/unkernel/next /opt/unkernel/current
```

Create `/etc/systemd/system/unkernel-web.service`. Use a system-wide Node
24+ binary in `ExecStart`. Adjust the example’s absolute path to match your
installation.

```ini
[Unit]
Description=Unkernel web app
After=network.target

[Service]
Type=simple
User=unkernel
Group=unkernel
WorkingDirectory=/opt/unkernel/current
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=3000
ExecStart=/usr/local/bin/node /opt/unkernel/current/server/index.mjs
Restart=on-failure
RestartSec=3s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now unkernel-web
curl -fsS -o /dev/null http://127.0.0.1:3000/
```

### 4. Run the Wisp relay under systemd

Wisp accepts a WebSocket from the browser and multiplexes the guest’s outbound
connections through it. Install the Wisp v1 relay in a dedicated Python
environment. Keep its default loopback and private-address restrictions.
[Mercury Workshop Wisp server](https://github.com/MercuryWorkshop/wisp-server-python) · [Python package](https://pypi.org/project/wisp-python/)

```sh
sudo apt-get install -y python3-venv
getent passwd unkernel-wisp >/dev/null ||
  sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin unkernel-wisp
sudo python3 -m venv /opt/unkernel-wisp/venv
sudo /opt/unkernel-wisp/venv/bin/python -m pip install 'wisp-python==0.11.0'
```

Create `/etc/systemd/system/unkernel-wisp.service`.

```ini
[Unit]
Description=Unkernel Wisp v1 relay
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=unkernel-wisp
Group=unkernel-wisp
ExecStart=/opt/unkernel-wisp/venv/bin/python -m wisp.server --host 127.0.0.1 --port 6680 --threads 2 --block-udp
Restart=on-failure
RestartSec=3s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now unkernel-wisp
sudo ss -ltnp '( sport = :3000 or sport = :6680 )'
```

Both listeners should be on `127.0.0.1`. The relay needs server-side DNS and
outbound TCP to the sites guests use. Protect public access to the relay with
authentication or a private network. An Origin check alone does not
authenticate a client.

### 5. Put both services behind HTTPS

Install Caddy 2.8 or newer with its systemd service. Run `caddy hash-password`
to generate the bcrypt hash for the user in the example. Add this site block
to `/etc/caddy/Caddyfile` and substitute your hostname and hash. Caddy manages
TLS and forwards WebSocket upgrades. The same login protects the app and
relay, and the relay accepts the site’s exact Origin. [Install Caddy](https://caddyserver.com/docs/install) · [Caddy basic auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth)

```caddyfile
vm.example.com {
    route {
        basic_auth {
            vmadmin REPLACE_WITH_BCRYPT_HASH
        }

        @wrong_origin {
            path /wisp/
            not header Origin https://vm.example.com
        }
        respond @wrong_origin 403

        handle /wisp/ {
            rewrite * /
            reverse_proxy 127.0.0.1:6680 {
                header_up -Authorization
            }
        }

        handle {
            reverse_proxy 127.0.0.1:3000 {
                header_up -Authorization
            }
        }
    }
}
```

```sh
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

Serve the app at the hostname’s root so `/vm-sw.js`, `/vm/` and `/distros/`
reach the right handlers. Preserve the app’s `Cross-Origin-Opener-Policy:
same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers for
cross-origin isolation and multiple guest CPUs. Distro assets need byte
ranges with stable ETags and no response compression. Leave Caddy encoding
disabled for these routes if you add it elsewhere.

### 6. Connect the browser and verify the deployment

Open `https://vm.example.com/?wisp=wss%3A%2F%2Fvm.example.com%2Fwisp%2F` and
sign in. For a saved browser preference, choose **System → Network →
Wisp, custom servers**, enter `wss://vm.example.com/wisp/`, and use
**Reboot to apply**. To make it the default for every new browser, set the
relay URL in `DEFAULT_WISP_SERVERS` in [`js/core/net-wisp.ts`](js/core/net-wisp.ts)
and rebuild the web app. The upstream default is restricted to approved
origins.

```sh
curl -sSI https://vm.example.com/
curl -fsSI -u vmadmin https://vm.example.com/
image=$(find /opt/unkernel/current/public/distros -name 'debian-*.erofs' -printf '%f\n' | head -1)
curl -fsS -u vmadmin -D - -o /dev/null -H 'Range: bytes=0-4095' \
  "https://vm.example.com/distros/$image"
```

Expect `401` without credentials, `200` with credentials and both isolation
headers, and `206 Partial Content` with a `Content-Range` for the distro
request. Browser developer tools should show a `101 Switching Protocols`
response at `/wisp/`. In Debian, run `curl -fsSL https://deb.debian.org/ -o /dev/null`
to check guest DNS and HTTPS through the relay. For a full smoke test, boot
Xfce, check that Terminal ↔ Desktop works, and reopen a disposable saved
folder after a clean shutdown. A relay response of `401` points to login,
`403` to the request’s Origin, and `502` to the relay service or its
loopback port.

If Desktop shows `kwtty: exec systemctl: No such file or directory`, boot
Debian in Terminal view and run `cat /proc/1/comm` and `command -v systemctl`.
The fork image should return `systemd` and `/usr/bin/systemctl`. If the same
check fails in a temporary session, verify the served distro image against
the build in step 1 and redeploy the complete `web/.output/`. If it only
fails with one saved disk, back it up and try Safe mode to isolate
the saved root overlay.

For upgrades, build the next checkout, install it as a new versioned release,
and switch the `current` link as in step 3. Coordinate a clean shutdown of
active VMs before changing the served assets. Restart `unkernel-web` and run
the checks again. To roll back, point `current` at the previous release and
restart the web service. Keep the hostname stable so browsers retain access
to the same origin’s IndexedDB. A locally chosen save folder can also be
selected on the new origin. Inspect service logs with
`journalctl -u unkernel-web -u unkernel-wisp -u caddy -f`.

## About unkernel

unkernel is Linux 7.x built as a single wasm module with a real MMU. The
kernel (syscalls, scheduler, memory management, ext4, TCP/IP) is compiled
code, not emulated, so programs get Linux's own behavior down to the edge
cases. Only user programs are emulated: unmodified aarch64 (arm64) Linux
binaries, so Alpine and Debian packages run as they are.

[Open a page](#-try-it-in-the-browser) and you have a Linux machine with a
shell, a package manager, a persistent disk, internet access, and a screen
with sound. The VM runs on your device, and every layer is open source. [How it works](#-how-it-works)
explains the design.

<p align="center">
  <img alt="Linux programs run on kwemu, an aarch64 CPU linked into the Linux kernel, built together into unkernel.wasm, which talks to the JavaScript SDK" src="assets/architecture.svg" width="760">
</p>

## ⚡ Performance

Much of what makes a system feel slow lives in the kernel: starting
processes, syscalls, page faults, file and network I/O. In unkernel that
path runs at wasm speed.

- **Boot**: the kernel reaches `/init` about 70 ms after it starts, and the Alpine
  prompt appears 0.3 s after `node` launches. The page downloads about
  10 MB, and Alpine boots in 48 MiB of guest memory.
- **Syscalls at close to native cost**: `getppid` takes about 170 ns (110
  native, 1.7 µs under qemu-system), a 64-byte `read` about 170 ns (160
  native).
- **fork at native speed**: fork + exit + wait takes about 60 µs, against
  about 70 µs natively and 1.2 ms under qemu-system.
- **A JIT for user code**: hot aarch64 code, including the AES, PMULL and
  SHA instructions OpenSSL uses, is compiled to wasm while it runs. With
  it a shell loop runs 1.6 times and `sort` 2.3 times as fast as on the
  interpreter alone, and OpenSSL in the guest does AES-128-GCM at about
  100 MB/s and SHA-256 at about 160 MB/s.

The syscall and fork numbers were measured on 2026-11-14 (with the
riscv64 user space the project started with; the path through the kernel
is the same), the JIT numbers on 2026-11-18. CPU-heavy programs are well
behind native: `apk search` over the main index takes about 0.8 s, `apk
add python3` about 3.4 s. [Benchmarks](#-benchmarks) has the full numbers.

## 🐧 A real kernel

Anything a program relies on, from `/proc` and `epoll` to cgroups and
overlayfs, behaves as it does on a server, because it runs the same code.

- **A real MMU** (`arch/wasm` with Sv39 page tables): `fork`, `mmap`,
  copy-on-write, shared memory, threads and signals behave as they do on
  hardware. This is not a NOMMU port where programs are limited to `vfork`.
- **Linux's own file systems**: ext4, overlayfs, tmpfs, loop devices, FUSE,
  and 9p, which [mounts file systems](#mount-host-files) your program serves
  from the host. The root file system is an overlay: a read-only distro
  image under your changes, which go to a persistent ext4 disk, so
  everything you change survives a reload, and a safe mode recovers a
  system you broke.
- **Linux's own TCP/IP stack**, with DHCP and DNS, reaching the internet
  through your host's sockets or a Wisp proxy
  ([Add a network](#add-a-network)).
- **cgroups, namespaces, userfaultfd, fanotify and TUN**: enough for
  systemd to boot Ubuntu 26.10 to `multi-user.target`.
- **Devices**: a [framebuffer (`/dev/fb0`), evdev keyboard, mouse and touch,
  sound through ALSA and `/dev/dsp`](#display-input-and-sound),
  [AF_VSOCK](#talk-over-vsock), and [shared memory](#share-memory) with the
  host.
- **aarch64 user space**: ARMv8.0-A with FP and AdvSIMD plus the AES,
  PMULL, SHA1, SHA2, SHA512, SHA3, CRC32 and LSE atomics extensions, so
  distribution binaries and
  OpenSSL's hardware AES, GHASH and SHA paths run unchanged. aarch64 is a
  first-class port of
  every distribution, so their full, current package archives are
  available.

[Known limits](#-known-limits) lists what is still missing.

## 🧰 What you can do with it

- **[Carry a Linux shell anywhere](#-try-it-in-the-browser).** Alpine Linux
  3.24 runs in Chrome, Edge, Firefox and Safari, including on phones. Install
  anything with `apk add` from Alpine's regular mirrors. Type a command that
  isn't installed, such as `htop`, and its package is installed for you. apk
  starts with only the `main` repository, because it is about 4x faster that
  way; `community` is added the first time a command needs it.
- **Run real runtimes and tools**: Node and npm, Python, OpenSSL, curl and
  `wget`, straight from the distribution. Debian 13 is the default, with
  systemd, APT, Xfce, Git, GCC, Make and Python.
- **[Write graphics and sound programs](#display-input-and-sound)** against
  `/dev/fb0`, evdev and ALSA. Try `glimmer`, a tiny game with sound.
- **[Embed Linux in your app](#-use-it-from-javascript)** with a
  zero-dependency TypeScript SDK, published as
  [`unkernel`](https://www.npmjs.com/package/unkernel). The same kernel file
  runs in Node and in every supported browser, optionally [in a
  worker](#run-it-in-a-worker). [Disks](#add-disks) can be local ext4 images,
  http(s) images fetched by range, or a persistent disk in IndexedDB. The SDK
  is MIT-licensed, and there is no closed engine or license key behind it, so
  you can ship it in your product and host it wherever you like.
- **Talk to the guest** through [terminal sessions](#run-programs), each
  with its own pty and shell, [host directories and in-memory file
  systems](#mount-host-files) mounted in the guest, [vsock byte
  streams](#talk-over-vsock) and [zero-copy shared memory](#share-memory),
  with no network in between.
- **Script and test**: [the CLI](#-run-it-from-the-terminal) types input on a
  schedule, stops on a timeout, and reports how the guest ended in its exit
  code.

## 🌐 Try it in the browser

Open your [fork deployment](#deploy-on-a-server) or the [upstream demo](https://unkernel.dev/). A shell appears
after a download of about 10 MB. Your changes are saved in the browser, and
the status icon opens options, diagnostics, and export or reset for your
disk. Ctrl-A n (or ⌘A n on a Mac) or `+` on the status line opens another
terminal window with its own shell, up to 9; Ctrl-A and a digit switches.

The page takes a few URL parameters:

| Parameter | Does |
| --- | --- |
| `?mem=512` / `?mem=max` | Guest memory in MiB, up to 4096. Use `max` to try 4 GiB and fall back to smaller allocations if needed. |
| `?zram=512` / `?zram=0` | Debian compressed swap capacity in MiB. The default is half the guest’s usable RAM. Use `0` to turn it off. |
| `?append=...` | Extra kernel command line |
| `?net=0` | Boot without a network |
| `?wisp=wss://...` | Use your own [Wisp](https://github.com/MercuryWorkshop/wisp-protocol) proxy |
| `?jit=0` | Interpreter only |
| `?data=0` | Temporary session, a fresh system every time |
| `?storage=browser` | Skip the storage picker and use IndexedDB |
| `?view=terminal` / `?view=desktop` | Skip the Debian startup view choice |
| `?worker=0` | Run the kernel on the page's thread (default: in a Web Worker where the page is cross-origin isolated) |
| `?cpus=2` | Boot on that many CPUs, each in a Web Worker (default: half the device's threads, up to 4 on desktops and 2 in Firefox, one on phones, in Safari and on iOS, where the page has the SMP kernel and is cross-origin isolated; `?cpus=1`: one CPU) |

On browsers with a directory picker, choose **Choose folder** before boot
to save the ext4 data disk in an `unkernel-data` subdirectory. Debian starts
with 4 GiB of virtual disk capacity. Set a larger capacity when creating a
disk or choose **Grow disk** when reopening an existing folder. Debian
grows the mounted filesystem on boot and retries an interrupted resize on
the next boot. The folder uses host capacity as the guest writes blocks.

To move the guest, power it off and then choose the same parent folder in
the other browser. This restores installed packages, settings, and files.
Use the folder from one browser at a time. Browsers without a folder picker
can use IndexedDB or `?data=0`. After a clean poweroff or reboot, unkernel
compacts the folder when at least 256 batches have accumulated or a
checkpoint would reclaim at least 64 MiB. **Compact now** is available
after poweroff. Compaction temporarily needs room for the checkpoint.
Older builds must be updated before opening a compacted or grown folder.

For direct access to host files, open **Guest → Shared folders → Share
folder…** while the VM is running. The folder appears under
`/mnt/shared-<name>` for that session. Shares are read-only by default.
**Allow guest changes** enables writes and deletions in the selected local
folder. Atomic rename, Unix ownership and permission changes, and links
are unavailable for these local browser mounts.

Choose **Start in Desktop** at boot to start Xfce automatically. The
**Terminal / Desktop** button switches between the shell and the same
desktop session. The guest resolution follows the desktop view when
TigerVNC accepts a resize. The connection stays on the guest's vsock
bridge, so it also works with guest networking off.

To build the fork locally, run `./setup.sh`, then `pnpm install` and
`KW_LOCAL=1 pnpm dev`. For a web build using GitHub release assets, set
`KW_KERNEL_REPO=cnmoro/unkernel`.

Browsers can't open raw TCP sockets, so the page reaches the internet
through a Wisp proxy. The default one accepts only known origins, so if you
host the page somewhere else, point `?wisp=` at your own proxy.

| Browser | Status |
| --- | --- |
| Chrome / Edge 137+ (desktop and Android) | ✅ works |
| Firefox 153+ | ✅ works |
| Safari 27+ on macOS, any browser on iOS/iPadOS 27 | ✅ works |
| Anything without [JSPI](#-how-it-works) | the page tells you what's missing |

## 💻 Run it from the terminal

```sh
node js/cli.ts
```

After building the fork, this boots Debian through your host's network
sockets. Press **Ctrl-]** to quit. To use a fork release, install its
`unkernel.tgz` with npm and run `unkernel`.

```sh
node js/cli.ts --distro alpine                 # Use Alpine explicitly
node js/cli.ts --distro none                   # no distro: the base shell (busybox)
node js/cli.ts --data my-data.img              # changes persist on a /data disk, created on first use
node js/cli.ts --display --sound               # a framebuffer and a sound card
node js/cli.ts --mem 1024 --no-net             # more memory, no network
node js/cli.ts --mount .:/work                 # this directory at /work in the guest (:ro for read-only)
node js/cli.ts --forward 8000:80               # host 127.0.0.1:8000 to port 80 in the guest
node js/cli.ts --timeout 60 --input '{8}uname -a\n{2}poweroff\n'   # scripted: wait, type, wait, type
node js/cli.ts --help                          # everything else
```

Without `--data`, changes to the root file system are kept in memory and
gone at exit; with it, each distro keeps its own in `/data/distros/<name>/`.
`--distro` also takes an image file or an http(s) URL, and
`UNKERNEL_CACHE_DIR` moves the download cache.

### Tailscale in Debian

Inside the guest:

```sh
curl -fsSL https://tailscale.com/install.sh | sh
systemctl is-active tailscaled
sudo tailscale up
```

Open the sign-in URL printed by Tailscale. Its systemd service uses
userspace networking because the guest kernel lacks netfilter. For guest
apps that need to reach tailnet peers, use the SOCKS5 proxy, for example
`curl --proxy socks5h://127.0.0.1:1055 http://peer-name`. Peer traffic
crosses Tailscale's DERP relays on the TCP-only host network. Persistent
guest storage also saves the node identity under `/var/lib/tailscale`.

Exit codes: 0 power off, 1 halt or boot failure, 2 restart, 124 timeout, 253
kernel panic, 254 wasm trap, 255 fatal error. The CLI is built on the
[JavaScript SDK](#-use-it-from-javascript): `--mount` uses its [host
mounts](#mount-host-files) and `--forward` its
[`vm.connect()`](#talk-over-vsock).

## 🔍 How it works

Most "Linux in the browser" projects take one of three approaches:

- **Emulate a whole PC**, kernel included. This is faithful but slow,
  because every syscall and page fault goes through emulated hardware.
- **Emulate the CPU and reimplement the syscalls.** Programs run on an
  emulated CPU, often with a JIT, and a runtime answers their syscalls, with
  no Linux kernel at all. This is fast, but it covers only as much of Linux
  as the runtime implements.
- **Compile programs to wasm**, and run them on a kernel without an MMU or
  on a runtime that provides POSIX calls. This is fast, but native programs
  have to be rebuilt, and `fork` and anything else that needs an MMU breaks
  or is approximated.

unkernel keeps the best of each: the real Linux kernel, running at native
wasm speed, under unmodified binaries with a real MMU.

| Approach | Kernel | User space | MMU |
| --- | --- | --- | --- |
| Whole-machine emulators (v86, JSLinux, container2wasm, QEMU's wasm build) | Linux, emulated | unmodified, emulated | emulated |
| Syscall emulators | none: a runtime reimplements the syscalls | unmodified, emulated | the runtime's own |
| POSIX runtimes for wasm (Wasmer WASIX, WebContainers, BrowserPod) | none: a runtime provides the syscalls | rebuilt for wasm, or JavaScript | none |
| Linux without an MMU (linux-wasm, tombl/linux, WasmLinux (LKL)) | Linux, native wasm | rebuilt for wasm | none |
| **unkernel** | **Linux, native wasm** | **unmodified aarch64, emulated** | **real page tables** |

The kernel is compiled straight to WebAssembly. User programs run on
**kwemu**, an aarch64 CPU written in Zig and linked into the kernel. kwemu
walks the kernel's own page tables, so memory management is done by the
real Linux code.

When a program makes a syscall, kwemu returns to the kernel, which handles
it as native wasm. There is no emulated trap and no emulated kernel mode in
between. Task switches use JSPI (`WebAssembly.Suspending`), so the kernel
gets real stacks that it can suspend and resume.

kwemu runs blocks of guest code decoded once into compact ops (what has
no op runs through a reference interpreter), and hot user code goes
through a second tier: a JIT that compiles those blocks to wasm modules
at run time, with output that matches the interpreter bit for bit.
[Benchmarks](#-benchmarks) shows what each tier costs.

Devices are small paravirtual drivers that talk to the JavaScript host:
[block](#add-disks) (kwblk), [network](#add-a-network) (kwnet, with a
user-mode TCP/IP stack in JS), [display, input and
sound](#display-input-and-sound) (kwfb, kwinput, kwsnd),
[vsock](#talk-over-vsock) (kwvsock) and [shared memory](#share-memory)
(kwshm).

### 📊 Benchmarks

The design helps most with syscalls. These were measured under Node:

<p align="center">
  <img alt="Time per operation for native, qemu-user, qemu-system and unkernel: getppid 110, 320, 1662 and 172 ns; read 64 B from /dev/zero 161, 481, 2247 and 172 ns; pipe write + read 417, 1032, 7256 and 482 ns; fork + exit + wait 73, 537, 1178 and 57 µs" src="assets/performance.svg" width="760">
</p>

In this test (2026-11-14) fork is faster than native. Pure computation is
slower. kwemu's decoded-op interpreter runs integer code at about 250-300
million guest instructions per second under Node (2026-11-17), and the
JIT makes real Alpine work 1.6 to 2.3 times as fast as that (2026-11-18:
an ash loop 2.5 s against 4.0 s, `seq 100000 | sort -r` 3.1 s against
7.1 s, `seq 250000 | gzip | gunzip` 3.5 s against 6.5 s), which is still
well behind native.

### 🚧 Known limits

- The SDK and CLI boot one CPU by default; the page boots several where
  it can (`?cpus=`). Several CPUs (SMP) cannot be suspended.
- No IPv6, no UDP beyond DHCP and DNS, no inbound network connections
  ([`vm.connect()`, `vm.fetch()`](#talk-over-vsock) and `--forward` reach
  guest servers over vsock instead).
- No ptrace register sets, so `strace` and `gdb` don't work. No seccomp.
- Code that runs only a few times (a large program's startup, such as
  `npm`'s) stays on the interpreter, and FP and AdvSIMD floating point
  run through it even inside compiled code. Without wasm SIMD in the host
  engine, OpenSSL's AES and SHA paths run on the interpreter too.
- A wasm trap in the kernel ends the session.

## 🧩 Use it from JavaScript

```sh
npm install unkernel
```

```js
import { createKernel, fetchDistro } from "unkernel";

const vm = await createKernel({ distro: await fetchDistro("alpine") });   // Alpine, no network
vm.onOutput((bytes) => process.stdout.write(bytes));
vm.write("uname -a; poweroff\n");

const { code, kind } = await vm.exited;          // 0, "halt"
```

Importing `unkernel` picks the Node or browser entry automatically, and
`unkernel/node` or `unkernel/web` selects one explicitly. The kernel ships
in the package (`unkernel/unkernel.wasm`) and loads from next to the entry,
streamed and compiled while it downloads. It carries a small base system
that mounts a distro image read-only under an overlay root and runs its
init; `createKernel()` without `distro` boots the base shell
(busybox and unkernel's tools), which needs no download.

The distro images are not in the package. On Node, `fetchDistro("alpine")`
(or `"debian"`) downloads one once from the GitHub release of the
package's version, checks it against the release's `distros.json` (size and
SHA-256), keeps it in `~/.cache/unkernel` (`UNKERNEL_CACHE_DIR`) and
returns its path; nothing else in the SDK downloads anything. In the
browser, host the image yourself (it is read lazily with range requests)
and pass its URL:

```js
const vm = await createKernel({ distro: "/distros/alpine.erofs" });
```

Changes to the root file system stay in memory, unless a persistent data
disk (labelled `kwdata`) is attached: then each distro keeps them in
`/data/distros/<name>/` on it.

### Add a network

```js
import { createKernel, directBackend, wispBackend, DEFAULT_WISP_SERVERS } from "unkernel";

await createKernel({ net: directBackend() });                       // Node: host sockets
await createKernel({ net: wispBackend(DEFAULT_WISP_SERVERS) });     // anywhere: a Wisp proxy
```

Networking is off unless you pass `net`. Any object with `connect` and
`lookup` methods can carry the guest's TCP and DNS, so you can write your
own backend.

### Add disks

```js
import { createImageFromKwsparse, createKernel, bundledBoot, openDisk } from "unkernel/node";

const vm = await createKernel({
  distro,
  disks: [await openDisk("data.img")],           // the data disk, or any ext4 image or https:// URL
});
```

`createImageFromKwsparse(file, template)` makes a new data disk from the
template the kernel carries (`bundledBoot(module).datadisk`). In the
browser, `openHttpDisk(url)` keeps your writes in IndexedDB and
`openDataDisk()` gives you the persistent data disk that
[the page](#-try-it-in-the-browser) uses. Anything that implements
`BlockDevice` works too, and a disk of your own can be the root:
`cmdline: "console=hvc0 root=/dev/wda rw"` with `initrd: null`.

### Console and lifecycle

```js
// vm.output: a ReadableStream, everything since boot and then live
vm.output.pipeTo(new WritableStream({ write: (b) => process.stdout.write(b) }));
vm.write("ls /\n");                              // or write to vm.input, a WritableStream
vm.resize(120, 40);                              // the foreground program gets SIGWINCH

await vm.sync();                                 // flush the guest's disks
console.log(vm.stats());                         // memory, disk, network and JIT counters
const { code, reason, kind } = await vm.exited;  // stop() parks it at once
```

### Run programs

```js
const { stdout, exitCode } = await vm.exec("uname", ["-a"]);
const { stdout: sum } = await vm.exec("sha256sum", [], { input: "hello" });
```

`exec()` runs a program on pipes and resolves with `{ stdout, stderr,
exitCode, signal }`, also for a non-zero exit. Pass `encoding: "buffer"`
for bytes, and `cwd` or `env` as you would to `child_process`. On the
distro images programs run as the user `user` (uid 1000, in
`/home/user`), who has `sudo` without a password; pass `user: "root"` (or
another name or uid) to run as someone else. The base shell is root's.

```js
const sh = await vm.spawn();                     // a login shell on its own pty
sh.output.pipeTo(new WritableStream({ write: (b) => process.stdout.write(b) }));
await sh.write("cat /etc/alpine-release; exit\n");
console.log(await sh.ended);                     // { type: "exit", code: 0 }
```

`spawn(file, args, { cols, rows })` runs a program on a pty, in the
zigpty / node-pty shape, with `resize()`, `kill(signal)` and `close()` (a
hangup). Run as many as you like. Keep reading `output`: the guest program
waits while nobody does.

```js
const gz = await vm.spawn("gzip", ["-c"], { pty: false });
gz.stderr.cancel();                              // read both outputs, or cancel one
const zipped = new Response(gz.stdout).bytes();
await new Response("hello\n").body.pipeTo(gz.stdin);   // then EOF
console.log((await zipped).length);
```

With `pty: false` the program gets pipes: `stdin`, `stdout` and `stderr`
web streams, byte for byte.

### Mount host files

```js
import { createKernel, MemoryFs, nodeFs } from "unkernel";

const mem = new MemoryFs();
mem.onChange((c) => console.log(c.type, c.path));   // what the guest changed

const vm = await createKernel({
  mounts: {
    "/mnt/host": { "hello.txt": "hi", dir: { "a.bin": bytes }, "now.txt": () => Date() },
    "/mnt/mem": mem,
  },
});
await vm.exec("cp", ["/etc/os-release", "/mnt/mem/"]);
console.log(mem.readText("/os-release"));

const work = await vm.mount("/work", nodeFs("."), { readOnly: true });   // Node only
await work.unmount();
```

A file system is a plain object tree (a function is a computed file,
evaluated once per open), a `MemoryFs` you read and write from the host,
`nodeFs(dir)`, or your own `Fs`: `getattr`, `readdir` and `open` by path,
sync or async, plus whichever change methods you want. Mounts are served
over 9p on vsock. Each guest write reaches the host as it happens, and a
host change shows in the guest within a second.

### Talk over vsock

```js
const listener = vm.vsock.listen(5000);          // guest programs connect to CID 2, port 5000
vm.write("echo hello | kwvsock connect 5000\n");
const conn = await listener.accept();
console.log(await new Response(conn.readable).text());   // "hello\n"
conn.close();

const c = await vm.vsock.connect(6000);          // a guest program listening on port 6000
await c.writable.getWriter().write("ping");
```

These are byte streams with real flow control and no network in between.
vsock is on unless you pass `vsock: false`.

```js
const sock = await vm.connect(8000);             // TCP to the guest's 127.0.0.1:8000
await new Response("hello\n").body.pipeTo(sock.writable);   // then EOF (a half-close)
console.log(await new Response(sock.readable).text());
```

`vm.connect(port)` reaches a TCP server on the guest's loopback through
the guest's kwtty, over vsock, so it needs no network. It resolves once
the guest has connected (`PtyError` `ECONNREFUSED` if nothing listens) with
`readable` and `writable` byte streams, half-close included, `close()` and
`closed`. [The CLI's](#-run-it-from-the-terminal) `--forward
HOSTPORT:GUESTPORT` uses it.

`vm.fetch(url, init)` sends an HTTP/1.1 request to a server in the guest
and returns a `Response` whose body streams. It always connects to the
guest's 127.0.0.1 at the URL's port; the host name only goes into the
`Host` header, so `vm.fetch("http://localhost:8000/")` reaches a dev server
listening on port 8000. `fetchOver(connect, url, init)` is the same client
over any byte stream.

### Share memory

```js
const vm = await createKernel({ shm: true });
await vm.exec("sh", ["-c", "printf result > /dev/shm/output"]);

const output = await vm.shm.open("output");      // a file a guest program made
const data = await output.read();
const views = output.views();                    // zero-copy, until the kernel runs again

const input = await vm.shm.create("input", 1 << 20);   // /dev/shm/input in the guest
await input.write(0, bytes);
```

`/dev/shm` exists once the guest's init has mounted it, so wait for the
guest before `create()` (an `exec()` waits for it). `openId(id)` opens a
memfd that a guest program exported through `/dev/kwshm`. `views()`
exists only when the kernel runs inline.

### Display, input and sound

```js
import { createKernel, domCodeToLinux, pcmToFloat32 } from "unkernel";

const vm = await createKernel({
  display: { width: 800, height: 600 },          // the guest gets /dev/fb0
  onDisplay: (mode) => console.log(mode),        // a program opened it (its mode) or closed it (null)
  sound: { onChunk: ({ data, format }) => play(pcmToFloat32(data, format)) },
});

const frame = vm.frame();                        // RGBA, or null while nothing draws
if (frame) ctx.putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);

addEventListener("keydown", (e) => {
  const key = domCodeToLinux(e.code);
  if (key && vm.evdev.keyboardOpen) vm.evdev.key(key, true);
});
```

`evdev` also has `button()`, `move()`, `moveTo()` and `wheel()` for a
mouse or tablet. `onInput` tells you when a program opens the keyboard
and mouse; until then, send keys to the console. `readFrame()` waits for
a fresh frame.

### Run it in a worker

```js
const vm = await createKernel({
  worker: true,
  distro,                                        // a path or URL
  net: { kind: "net", backend: { kind: "direct" } },
  disks: [{ kind: "file", path: "data.img" }],
});
```

The kernel runs in a worker thread or Web Worker, with the same API. Disks
and the network are given as specs, which the worker builds: `{ kind:
"file", path }` on Node, `{ kind: "http", url }` and `{ kind: "data",
template: "bundled" }` in browsers. Input and frames go through shared
memory when it is available (`vm.transport` says). This mode is
experimental.

An SMP kernel (a bundle with the SMP patch) boots on several CPUs with
`cpus: 4`, each CPU in a thread of its own on one shared memory. In
browsers that needs a cross-origin isolated page and `worker: true`,
because a CPU blocks while it waits for another, which a page's main
thread may not; `webCpuBlocker()` says why it cannot, and
`vm.stats().cpus` how many CPUs the kernel got.

On a server, `worker: true` keeps the event loop free at no cost in speed,
and `cpus: 4` gets most of what more CPUs give (about 3x on parallel work;
8 or 16 add little, and each CPU adds to boot time and takes 8 MiB of
guest memory). `node test/profile.ts` measures your host, and the page's
`/profile.html` a browser.

### Boot options and helpers

```js
import { checkSupport, ConsoleRouter, createKernel } from "unkernel";

const support = await checkSupport();            // JSPI and the rest, before you boot
if (!support.ok) throw new Error(support.problems.join("\n"));

const vm = await createKernel({
  kernel: "./my-kernel.wasm",                    // a URL, bytes, a Response or a WebAssembly.Module
  initrd: "./initramfs.cpio.gz",                 // null: none
  cmdline: "console=hvc0 rdinit=/init",
  memoryMiB: 1024,
  jit: false,                                    // interpreter only
  onProgress: (p) => console.log(p.stage),
});

const router = new ConsoleRouter({               // kernel log lines apart from program output
  onKernelLine: (line, { important }) => important && console.warn(line),
  onUserOutput: (text) => process.stdout.write(text),
});
vm.onOutput((bytes) => router.write(bytes));
```

The SDK has some limits, on top of the kernel's [known
limits](#-known-limits). There is no guest agent beyond terminal sessions, so
you drive the guest through a terminal or its console, or over vsock with your
own program. `stop()` doesn't shut the guest down cleanly, so prefer
`poweroff`. Only one kernel can run per thread. Types ship as `.d.mts` and use
the DOM's `WebAssembly` types, so a Node-only TypeScript project needs `"lib":
["dom"]` or `skipLibCheck`.

## 🛠️ Building from source

You need Linux (x86-64 or arm64), Zig 0.16, Node 24, clang 21+ with the
wasm target, and the usual build tools. `./setup.sh --check` lists what's
missing. The first build takes about 12 minutes, most of it spent on a
patched `wasm-ld`, and uses 5 GiB of disk.

```sh
./setup.sh              # check, then build everything
node js/cli.ts          # boot your build (Alpine from vendor/build/distro/)
pnpm install && pnpm dev   # the web page at http://localhost:8080
zig build test          # emulator tests
```

The build makes the kernel bundle `vendor/build/bundle/unkernel.wasm` and
the distro images `vendor/build/distro/{alpine,debian}.erofs` with their
index `distros.json`; a source checkout uses those and never downloads
them. [guest/README.md](guest/README.md) describes the base system and how
to add a distro.

[kernel/README.md](kernel/README.md) maps the kernel directory and its
build steps. [AGENTS.md](AGENTS.md) and [.agents/](.agents/) hold the
contributor notes: the kernel, its devices and the guest image, invariants,
workflows, which tests to run, and the [roadmap](.agents/status.md).

## 🙏 Credits

Made with ♥ by [Pooya Parsa](https://x.com/_pi0_) ([pi0](https://github.com/pi0)), sponsored by
[▲ Vercel](https://vercel.com/open-source-program).

Thanks to:

- [Kernarium](https://github.com/imxieyi/Kernarium), for the idea: a native
  kernel with emulated user space behind a software MMU.
- [linux-wasm](https://github.com/joelseverin/linux-wasm) by Joel Severin,
  for the `arch/wasm` port this kernel grew from, the wasm-ld linker-script
  patches and the Kbuild toolchain wrapper.
- [iSH](https://github.com/ish-app/ish) and [v86](https://github.com/copy/v86),
  for showing how to build a fast user-mode emulator and a wasm JIT.
- [Alpine Linux](https://alpinelinux.org/), [wterm](https://wterm.dev/) and
  [Binaryen](https://github.com/WebAssembly/binaryen).

## 📄 License

Everything is open source: the kernel patches, the emulator and its JIT,
the patched linker, the SDK and the page. `./setup.sh` rebuilds the kernel
file from source.

The project is GPL-2.0-or-later ([LICENSE](LICENSE)) unless a file says
otherwise. The JavaScript SDK and page (`js/`, `web/`, SDK tests) are MIT
([LICENSE-MIT](LICENSE-MIT)), so you can embed them anywhere.

The npm package ships a Linux kernel (GPL-2.0) with a small base system
(Alpine's static busybox, GPL-2.0, and unkernel's own tools), so it is `MIT
AND GPL-2.0-only`. The distro images it downloads hold the distributions'
packages, which keep their own licenses. The
kernel's source is Linux 7.3.4 plus
[kernel/patches/linux](kernel/patches/linux) (`arch/wasm` is based on
linux-wasm's). Those patches and
`kernel/tools/fake-llvm` are GPL-2.0-only, and the patches in
`kernel/patches/llvm` follow LLVM's license (Apache-2.0 WITH
LLVM-exception).
