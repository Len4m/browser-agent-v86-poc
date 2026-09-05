// Browser Agent v86 - shared app state and constants.

import type { CowDisk, WorkspacePersistence } from "../vm/indexeddb-cow-disk";
import type { ResolvedVmRuntime } from "../vm/runtime-config";

export const NL = String.fromCharCode(10);
export const CR = String.fromCharCode(13);

export interface ConsoleTab {
  id: string;
  owner: string;
  title: string;
  transport: string;
  humanNumber?: number;
  closable: boolean;
  status: string;
  userInputSeen?: boolean;
  sessionId?: string;
  term?: unknown;
  fitAddon?: unknown;
  element?: HTMLElement | null;
  [key: string]: unknown;
}

interface AppState {
  vm: unknown;
  vmReady: boolean;
  pending: unknown;
  bootBuffer: string;
  wsSocket: WebSocket | null;
  wsConnecting: boolean;
  wsRetryAttempt: number;
  wsRetryTimer: number;
  wsManualDisconnect: boolean;
  checksRunning: boolean;
  networkAutoRequested: boolean;
  networkConfigured: boolean;
  networkConfiguring: boolean;
  agentBusy: boolean;
  vmStarting: boolean;
  vmStartAbortController: AbortController | null;
  loadingCancelHandler: (() => void) | null;
  activeRuntime: ResolvedVmRuntime | null;
  activeCowDisk: CowDisk | null;
  workspaceStatus: WorkspacePersistence | "none" | "temporary" | "syncing";
  assetBuffers: Record<string, ArrayBuffer> | null;
  assetCacheKey: string;
  profiles: unknown[];
  serialResizeObserver: ResizeObserver | null;
  serialFitRaf: number;
  serialScrollRaf: number;
  serialWriteDisposable: { dispose?: () => void } | null;
  serialKeyHandlerAttached: boolean;
  serialContextMenuContainer: Element | null;
  serialContextMenuHandler: ((event: Event) => void) | null;
  snapshotRestoring: boolean;
  consoleTabs: {
    uiReady: boolean;
    ready: boolean;
    extraReady: boolean;
    initializing: boolean;
    initTimer: number;
    activeId: string;
    fixedCols: number;
    fixedRows: number;
    maxHumanConsoles: number;
    controlBusy: boolean;
    renameOpen: boolean;
    clickTimer: number;
    outputDisposable: { dispose?: () => void } | null;
    eventDisposable: { dispose?: () => void } | null;
    tabs: ConsoleTab[];
  };
  bgTools: {
    pending: unknown;
    lastResult: unknown;
    liveText: string;
    diagnosticText: string;
    serial1Seen: boolean;
    runnerReady: boolean;
    lastError: string;
    mounted: boolean;
  };
}

export const state: AppState = {
  vm: null,
  vmReady: false,
  pending: null,
  bootBuffer: "",
  wsSocket: null,
  wsConnecting: false,
  wsRetryAttempt: 0,
  wsRetryTimer: 0,
  wsManualDisconnect: false,
  checksRunning: false,
  networkAutoRequested: false,
  networkConfigured: false,
  networkConfiguring: false,
  agentBusy: false,
  vmStarting: false,
  vmStartAbortController: null,
  loadingCancelHandler: null,
  activeRuntime: null,
  activeCowDisk: null,
  workspaceStatus: "none",
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

export const DOCKER_WSNIC_ISOLATED_COMMAND = "docker rm -f browser-agent-wsnic 2>/dev/null || true; docker run -d --name browser-agent-wsnic --restart unless-stopped --cap-add=NET_ADMIN --device /dev/net/tun:/dev/net/tun -p 127.0.0.1:8086:8086 chschnell86/wsnic";
export const DOCKER_WSNIC_COMMAND = `${DOCKER_WSNIC_ISOLATED_COMMAND} -i`;
export const VM_NETWORK_COMMAND = "echo NET_CONFIG_START; IFACE=$(ls /sys/class/net | grep -v '^lo$' | head -n1); if [ -z \"$IFACE\" ]; then echo LOAD_NET_MODULES; if [ -f /etc/v86-net-modules.list ]; then while read m; do [ -f \"$m\" ] && insmod \"$m\" 2>>/tmp/v86-net-runtime.log || true; done < /etc/v86-net-modules.list; fi; if [ -e /sys/bus/pci/devices/0000:00:05.0 ] && [ ! -e /sys/bus/pci/devices/0000:00:05.0/driver ] && [ -e /sys/bus/pci/drivers/ne2k-pci/bind ]; then echo 0000:00:05.0 > /sys/bus/pci/drivers/ne2k-pci/bind 2>>/tmp/v86-net-runtime.log || true; fi; sleep 1; IFACE=$(ls /sys/class/net | grep -v '^lo$' | head -n1); fi; echo IFACE=$IFACE; if [ -z \"$IFACE\" ]; then echo NO_NET_DEVICE; echo PCI_DEVICES_START; for d in /sys/bus/pci/devices/*; do [ -e \"$d\" ] || continue; echo \"$(basename $d) vendor=$(cat $d/vendor 2>/dev/null) device=$(cat $d/device 2>/dev/null) class=$(cat $d/class 2>/dev/null) driver=$(basename $(readlink $d/driver 2>/dev/null) 2>/dev/null)\"; done; echo RUNTIME_MODULE_LOG_START; cat /tmp/v86-net-runtime.log 2>/dev/null || true; echo DMESG_NET_START; dmesg | tail -120; echo NET_FAILED; false; else ip link set \"$IFACE\" up; if ip -4 addr show \"$IFACE\" | grep -q 'inet '; then echo DHCP_OK; elif udhcpc -i \"$IFACE\" -n -q -T 3 -t 2 || udhcpc -i \"$IFACE\" -n -q -T 4 -t 2; then echo DHCP_OK; else echo DHCP_FAIL; fi; printf 'nameserver 1.1.1.1\\nnameserver 8.8.8.8\\n' > /etc/resolv.conf; ip -4 addr show \"$IFACE\"; route -n; cat /etc/resolv.conf; nslookup example.com 1.1.1.1 >/dev/null 2>&1 && echo DNS_UDP_OK || echo DNS_UDP_FAIL; ping -c 1 -W 2 1.1.1.1 >/dev/null 2>&1 && echo PING_OK || echo PING_FAIL; if wget -q -T 8 -O /tmp/browseragent.html https://browseragent.icu/; then echo TCP_OK; echo HTTP_BROWSER_AGENT_OK; else echo TCP_FAIL; echo HTTP_BROWSER_AGENT_FAIL; fi; fi";
export function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
