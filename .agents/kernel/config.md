# Kernel config

## Rules

- `arch/wasm/configs/kw_defconfig` is a hand-written list of explicit
  choices, and the last patch of the UP series. Never replace it with
  `savedefconfig` output. `kw_smp.config` adds the SMP options (smp.md).
- build.sh reruns `make kw_defconfig` (plus `kw_smp.config` for SMP)
  whenever a fragment is newer than `$KOUT/.config`, which overwrites any
  menuconfig change, and then checks that every option the fragments set is
  in `.config` as written, failing with the list otherwise. Kconfig drops
  options whose dependencies are not met without saying so, so check
  `$KOUT/.config` after a change.
- kwtest's `config:` check covers the options below.

## What is on, and why

- systemd: CGROUPS, NAMESPACES (UTS, IPC, PID, NET), KCMP, FANOTIFY,
  AUTOFS_FS, EXT4_FS_SECURITY (about 180 KiB).
- Cheap options tools probe for: CGROUP_PIDS, USER_NS (`unshare -r`,
  bubblewrap), CHECKPOINT_RESTORE (`/proc/PID/task/TID/children`), PSI
  (`/proc/pressure`), TASKSTATS with I/O accounting (`/proc/PID/io`),
  USERFAULTFD, IP_MULTICAST, the socket DIAGs (`ss` for unix, packet,
  netlink), BLK_DEV_LOOP with MIN_COUNT=0 (loops on demand through
  `/dev/loop-control`), TUN, MAGIC_SYSRQ with its passive handler
  (devices.md, kwinput). Together about 200 KB lowered (70 KB gzip) and
  25 KiB of RAM (2026-11-14).
- FUSE_FS for sshfs, rclone and AppImage (+129 KB raw, +48 KB gzip, 20 KiB
  RAM, 2026-11-14).
- VPNs and containers: policy routing (IP_ADVANCED_ROUTER with
  IP_MULTIPLE_TABLES: `ip rule`; tailscaled uses its table 52 and falls back
  to the main table without), VETH and DUMMY (built in, so a `dummy0` link
  exists at boot); together +64 KB raw, +24 KB gzip, 20 KiB RAM, no new
  imports (2026-11-17). tailscaled runs on `/dev/net/tun` with
  `tailscale up --netfilter-mode=off` (no netfilter) over relayed (DERP)
  connections (the host stack carries no UDP).
- OVERLAY_FS without optional features (data-disk.md; +116 KiB, 43 KiB
  gzip), the devices (devices.md), 9p (devices.md).
- EROFS_FS for a distro's read-only root image on kwblk: zstd, xattrs
  with POSIX ACLs and `security.*`, file-backed mounts; MISC_FILESYSTEMS
  is on for it, nothing else in that menu. +189 KB raw, +70 KB gzip (zstd
  alone +102 KB, +35 KB), no RAM, no new imports (2026-11-19). lz4, which
  EROFS_FS_ZIP always brings, does not work: erofs maps scattered pages
  with `vm_map_ram`/`vmap`, which VMALLOC_FLAT cannot, so lz4 files read
  as ENOMEM and an lz4 image with big pclusters (`mkfs.erofs -C`) does
  not mount. microLZMA is off (+21 KB, +8 KB gzip).
- Built-in swap and zram with lzo-rle allow Debian to enable compressed swap at boot.
- `FRAME_WARN=3072`: clang's wasm backend gives each variadic call its own
  16-byte stack slot (`snmp_seq_show` 2304 bytes, all others under 1024).
  The kernel builds without warnings; keep it that way.

## What is off

- No netfilter. BPF_SYSCALL, KEYS, IPV6, SECCOMP, modules and
  kallsyms are off.
- COREDUMP must stay off until the arch has `elf_core_copy_task_fpregs` and
  arm64 core notes (the registers from kwemu): without them a fault with a
  core limit is a wasm trap.
- IKCONFIG/IKCONFIG_PROC: clang crashes on `kernel/configs.o`.

Measured 2026-11-14, one per build (base `vmlinux32.wasm` 6.83 MB raw,
2.21 MB gzip -9; RAM from the boot "Memory:" line); remeasure if the tree
has moved a lot:

| Option(s) | raw | gzip | RAM | enables / checked |
| --- | ---: | ---: | ---: | --- |
| KEYS | +64 KB | +24 KB | 4 KiB | keyctl (systemd's other ENOSYS), cryptsetup |
| VFAT_FS + NLS 437, iso8859-1, utf8 | +92 KB | +35 KB | 20 KiB | FAT images |
| SWAP + ZRAM (lzo-rle) | +96 KB | +36 KB | 4 KiB | swap for 256 MiB phones; 64 MiB zram swapon worked |
| SQUASHFS (zlib, xz, zstd; zstd now comes with EROFS) | +156 KB | +56 KB | 16 KiB | AppImage, snap |
| TLS + CRYPTO_CHACHA20POLY1305 | +181 KB | +66 KB | 40 KiB | kTLS works, but curl, Node, Go, rustls, BoringSSL and busybox wget never use it |
| IO_URING | +192 KB | +71 KB | 16 KiB | liburing, PostgreSQL |
| IPV6 | +467 KB | +170 KB | 52 KiB | `::1` ping worked; out of scope for now |
| BPF_SYSCALL + CGROUP_BPF | +903 KB | +313 KB | 112 KiB | `docker run` (runc/crun device cgroup) worked with it |

## Measuring an option

Copy a built `$KOUT`, append the option to its `.config`, run `make
olddefconfig` and `vmlinux` with build.sh's make variables, lower it, and
compare sizes. Also diff the module's imports against the base build: a
new unresolved import (one the arch lacks) traps when it is called.
