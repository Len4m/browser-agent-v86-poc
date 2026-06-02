// @ts-nocheck
// Browser Agent v86 - 00 state constants
// Split from app.js in v9.35. Load order is defined in index.html.

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);

const state = {
  vm: null,
  vmReady: false,
  pending: null,
  bootBuffer: "",
  wsSocket: null,
  wsConnecting: false,
  checksRunning: false,
  networkAutoRequested: false,
  networkConfigured: false,
  networkConfiguring: false,
  agentBusy: false,
  vmStarting: false,
  activeRuntime: null,
  assetBuffers: null,
  assetCacheKey: "",
  profiles: [],
  serialResizeObserver: null,
  serialFitRaf: 0,
  serialScrollRaf: 0,
  serialWriteDisposable: null,
  serialKeyHandlerAttached: false,
  serialContextMenuContainer: null,
  serialContextMenuHandler: null,
  snapshotRestoring: false,
  diskMounted: false,
  consoleTabs: {
    uiReady: false,
    ready: false,
    extraReady: false,
    initializing: false,
    initTimer: 0,
    activeId: "human-1",
    // La pestaña 1 usa serial0 real. Las pestañas adicionales se respaldan con
    // PTYs dentro de la VM y se multiplexan por UART2/ttyS2.
    fixedCols: 100,
    fixedRows: 24,
    maxHumanConsoles: 4,
    controlBusy: false,
    renameOpen: false,
    clickTimer: 0,
    outputDisposable: null,
    eventDisposable: null,
    tabs: [
      { id: "human-1", owner: "human", title: "1", transport: "serial0", humanNumber: 1, closable: false, status: "pending", userInputSeen: false },
    ],
  },
  bgTools: {
    pending: null,
    lastResult: null,
    liveText: "",
    diagnosticText: "",
    serial1Seen: false,
    runnerReady: false,
    lastError: "",
    mounted: false,
  },
};

const DOCKER_WSNIC_COMMAND = "docker rm -f browser-agent-wsnic 2>/dev/null || true; docker run -d --name browser-agent-wsnic --restart unless-stopped --cap-add=NET_ADMIN --device /dev/net/tun:/dev/net/tun --sysctl net.ipv4.ip_forward=1 --sysctl net.ipv4.conf.all.forwarding=1 --sysctl net.ipv4.conf.default.forwarding=1 -p 127.0.0.1:8086:8086 chschnell86/wsnic -i";
const VM_NETWORK_COMMAND = "echo NET_CONFIG_START; IFACE=$(ls /sys/class/net | grep -v '^lo$' | head -n1); if [ -z \"$IFACE\" ]; then echo LOAD_NET_MODULES; if [ -f /etc/v86-net-modules.list ]; then while read m; do [ -f \"$m\" ] && insmod \"$m\" 2>>/tmp/v86-net-runtime.log || true; done < /etc/v86-net-modules.list; fi; if [ -e /sys/bus/pci/drivers/ne2k-pci/bind ]; then echo 0000:00:05.0 > /sys/bus/pci/drivers/ne2k-pci/bind 2>>/tmp/v86-net-runtime.log || true; fi; sleep 1; IFACE=$(ls /sys/class/net | grep -v '^lo$' | head -n1); fi; echo IFACE=$IFACE; if [ -z \"$IFACE\" ]; then echo NO_NET_DEVICE; echo PCI_DEVICES_START; for d in /sys/bus/pci/devices/*; do [ -e \"$d\" ] || continue; echo \"$(basename $d) vendor=$(cat $d/vendor 2>/dev/null) device=$(cat $d/device 2>/dev/null) class=$(cat $d/class 2>/dev/null) driver=$(basename $(readlink $d/driver 2>/dev/null) 2>/dev/null)\"; done; echo RUNTIME_MODULE_LOG_START; cat /tmp/v86-net-runtime.log 2>/dev/null || true; echo DMESG_NET_START; dmesg | tail -120; echo NET_FAILED; false; else ip link set \"$IFACE\" up; if ! ip -4 addr show \"$IFACE\" | grep -q 'inet '; then udhcpc -i \"$IFACE\" -n -q -T 3 -t 2 || udhcpc -i \"$IFACE\" -n -q -T 4 -t 2 || true; fi; printf 'nameserver 1.1.1.1\\nnameserver 8.8.8.8\\n' > /etc/resolv.conf; ip -4 addr show \"$IFACE\"; route -n; cat /etc/resolv.conf; ping -c 1 -W 2 1.1.1.1 >/dev/null 2>&1 && echo PING_OK || echo PING_FAIL; wget -q -T 8 -O /tmp/google.html http://www.google.com/generate_204 && echo HTTP_GOOGLE_OK || echo HTTP_GOOGLE_FAIL; fi";
const VM_DISK_MOUNT_COMMAND = "echo DISK_MOUNT_START; echo BUILD_ID_START; cat /etc/browser-agent-build-id 2>/dev/null || true; echo LOAD_STORAGE_MODULES; if [ -f /etc/v86-net-modules.list ]; then while read m; do [ -f \"$m\" ] && insmod \"$m\" 2>>/tmp/v86-disk-runtime.log || true; done < /etc/v86-net-modules.list; fi; sleep 1; echo PROC_PARTITIONS_START; cat /proc/partitions; echo BLOCK_DEVICES_START; ls -l /dev/hd* /dev/sd* /dev/vd* 2>/dev/null || true; DISK=; for d in /dev/hda /dev/sda /dev/vda /dev/hdc /dev/sdb; do if [ -b \"$d\" ]; then DISK=\"$d\"; break; fi; done; echo DISK=$DISK; if [ -z \"$DISK\" ]; then echo DISK_NOT_FOUND; echo DISK_MODULE_LOG_START; cat /tmp/v86-disk-runtime.log 2>/dev/null || true; echo DMESG_BLOCK_START; dmesg | grep -i -E 'hda|sda|vda|ide|ata|piix|block|ext2|ext4|scsi|virtio_blk' | tail -120; false; else mkdir -p /mnt/hda; if mountpoint -q /mnt/hda; then echo DISK_ALREADY_MOUNTED; df -h /mnt/hda; echo DISK_MOUNT_OK; else mount \"$DISK\" /mnt/hda 2>/tmp/v86-disk-mount.log || mount -t ext2 \"$DISK\" /mnt/hda 2>>/tmp/v86-disk-mount.log || mount -t ext4 \"$DISK\" /mnt/hda 2>>/tmp/v86-disk-mount.log; if mountpoint -q /mnt/hda; then echo DISK_MOUNT_OK; df -h /mnt/hda; echo browser-agent-v86-disk-test > /mnt/hda/browser-agent-test.txt; sync; ls -l /mnt/hda/browser-agent-test.txt; cat /mnt/hda/browser-agent-test.txt; echo DISK_RW_OK; else echo DISK_MOUNT_FAILED; cat /tmp/v86-disk-mount.log 2>/dev/null || true; echo DISK_MODULE_LOG_START; cat /tmp/v86-disk-runtime.log 2>/dev/null || true; echo DMESG_BLOCK_START; dmesg | grep -i -E 'hda|sda|vda|ide|ata|piix|block|ext2|ext4|scsi|virtio_blk' | tail -120; false; fi; fi; fi";
const VM_DISK_UNMOUNT_COMMAND = "echo DISK_UNMOUNT_START; if ! mountpoint -q /mnt/hda; then echo DISK_NOT_MOUNTED; else sync; umount /mnt/hda 2>/tmp/v86-disk-umount.log; if mountpoint -q /mnt/hda; then echo DISK_UNMOUNT_FAILED; cat /tmp/v86-disk-umount.log 2>/dev/null || true; echo DISK_BUSY_HINT; false; else echo DISK_UNMOUNT_OK; fi; fi";


const $ = (id) => document.getElementById(id);
