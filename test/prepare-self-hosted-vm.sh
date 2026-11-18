#!/usr/bin/env bash
set -euo pipefail

TASK_SOURCE=$(cd "$(dirname "$0")/.." && pwd)
TASK_OUTPUT=${1:?Pass an empty output directory for the VM fixture}
TASK_WEB=${NOOP_E2E_WEB_ASSETS:?Set NOOP_E2E_WEB_ASSETS to the installed Web bundle}
TASK_WORKERD=${NOOP_E2E_WORKERD:?Set NOOP_E2E_WORKERD to the pinned workerd binary}
TASK_BUN=${NOOP_E2E_BUN:-$(bun -e 'console.log(process.execPath)')}
TASK_KERNEL=${NOOP_E2E_VM_KERNEL:-/usr/lib/modules/$(uname -r)/vmlinuz}
TASK_MODULE=${NOOP_E2E_E1000_MODULE:-$(modinfo -n e1000)}
TASK_BUSYBOX_IMAGE=${NOOP_E2E_BUSYBOX_IMAGE:-alpine/socat:1.8.0.3}

if [[ $(uname -m) != x86_64 || ! -f "$TASK_WEB/index.html" || ! -f "$TASK_WORKERD" || ! -f "$TASK_KERNEL" || ! -f "$TASK_MODULE" ]]; then
  echo "The VM fixture requires Linux x86_64, a kernel, its e1000 module, workerd and real Web assets" >&2
  exit 1
fi
if [[ -e "$TASK_OUTPUT/root" || -e "$TASK_OUTPUT/initramfs.cpio.zst" ]]; then
  echo "Choose an empty fixture output directory" >&2
  exit 1
fi
mkdir -p "$TASK_OUTPUT"
TASK_OUTPUT=$(cd "$TASK_OUTPUT" && pwd)
TASK_ROOT="$TASK_OUTPUT/root"
mkdir -p "$TASK_ROOT"/{bin,dev,etc,proc,sys,tmp,state,lib,repo}
TASK_CONTAINER=$(docker create --pull never --entrypoint /bin/sh "$TASK_BUSYBOX_IMAGE")
trap 'docker rm -f "$TASK_CONTAINER" >/dev/null 2>&1 || true' EXIT
docker cp "$TASK_CONTAINER:/bin/busybox" "$TASK_ROOT/bin/busybox"
docker cp "$TASK_CONTAINER:/lib/ld-musl-x86_64.so.1" "$TASK_ROOT/lib/ld-musl-x86_64.so.1"
for TASK_CMD in sh mount mkdir ip insmod cat sleep; do ln -s busybox "$TASK_ROOT/bin/$TASK_CMD"; done
while IFS= read -r TASK_LIBRARY; do
  mkdir -p "$TASK_ROOT$(dirname "$TASK_LIBRARY")"
  cp -L "$TASK_LIBRARY" "$TASK_ROOT$TASK_LIBRARY"
done < <({ ldd "$TASK_BUN"; ldd "$TASK_WORKERD"; } | awk 'match($0, /\/[^ ]+/) { print substr($0, RSTART, RLENGTH) }' | sort -u)
if [[ -f /etc/ld.so.cache ]]; then cp /etc/ld.so.cache "$TASK_ROOT/etc/ld.so.cache"; fi
mkdir -p "$TASK_ROOT/etc/ssl/certs"
cp -L /etc/ssl/certs/ca-certificates.crt "$TASK_ROOT/etc/ssl/certs/ca-certificates.crt"
cp "$TASK_BUN" "$TASK_ROOT/bin/bun"
cp "$TASK_WORKERD" "$TASK_ROOT/bin/workerd"
if [[ $TASK_MODULE == *.zst ]]; then zstd -dq "$TASK_MODULE" -o "$TASK_ROOT/e1000.ko"; else cp "$TASK_MODULE" "$TASK_ROOT/e1000.ko"; fi
cp -a "$TASK_SOURCE"/{src,cloud,app,templates,presets,package.json,bunfig.toml,tsconfig.json} "$TASK_ROOT/repo/"
rm -rf "$TASK_ROOT/repo/app/dist/web/noop"
mkdir -p "$TASK_ROOT/repo/app/dist/web"
cp -a "$TASK_WEB" "$TASK_ROOT/repo/app/dist/web/noop"
cat > "$TASK_ROOT/init" <<'INIT'
#!/bin/sh
export PATH=/bin:/usr/bin
mount -t proc proc /proc
mount -t sysfs sys /sys
mount -t devtmpfs dev /dev
insmod /e1000.ko
ip link set lo up
ip link set eth0 up
ip addr add 10.0.2.15/24 dev eth0
ip route add default via 10.0.2.2
mount -t ext4 /dev/vda /state
if [ ! -f /state/noop.toml ]; then printf '[server]\ntoken = "synthetic-vm-token-00000000000000"\n' > /state/noop.toml; fi
export NOOP_HOME=/state HUB_NO_MEDIC=1
cd /repo
exec /bin/bun /repo/src/cli.ts cloud deploy --local --listen 0.0.0.0:8790
INIT
chmod +x "$TASK_ROOT/init"
(cd "$TASK_SOURCE" && { rg --files src cloud app templates presets; printf '%s\n' package.json bunfig.toml tsconfig.json; } | sort | xargs sha256sum) > "$TASK_OUTPUT/source.SHA256SUMS"
sha256sum "$TASK_WEB/index.html" | cut -d ' ' -f 1 > "$TASK_OUTPUT/web.sha256"
sha256sum "$TASK_WORKERD" | cut -d ' ' -f 1 > "$TASK_OUTPUT/workerd.sha256"
sha256sum "$TASK_BUN" | cut -d ' ' -f 1 > "$TASK_OUTPUT/bun.sha256"
file -b "$TASK_KERNEL" > "$TASK_OUTPUT/kernel.txt"
(cd "$TASK_ROOT" && find . -print0 | cpio --null -o -H newc --owner=0:0 --quiet | zstd -q -T0 -3 > "$TASK_OUTPUT/initramfs.cpio.zst")
cp "$TASK_KERNEL" "$TASK_OUTPUT/vmlinuz"
echo "VM fixture: $TASK_OUTPUT"
