// Benchmark results shown at /benchmarks. Measured on 25 Oct 2026 with fresh workspaces, one per
// size, all on the same image; the client was a server in Roubaix, France (7 ms from Cloudflare).
// Rerun with the scripts described on the page and replace this data.

export interface SizeResult {
  size: string;
  location: string;
  /** Seconds: a new workspace's first start, waking from a snapshot, and going to sleep. */
  startFresh: number;
  wake: number;
  sleep: number;
  snapshotMB: number;
  /** Keystroke echo, ms (median / 90th percentile), through the web terminal and over SSH. */
  webEcho: [number, number];
  sshEcho: [number, number];
  /** Seconds for a warm `ssh hc-<name> true`. */
  sshCommand: number;
  /** SHA-256 MB/s: one process, and one per visible CPU. */
  sha1: number;
  shaAll: number;
  /** Seconds. */
  sqliteCompile: number;
  redisBuild: number;
  npmInstall: number;
  pythonLoop: number;
  /** MB/s. */
  diskWrite: number;
  diskRead: number;
  /** Mbit/s. */
  netDown: number;
  netUp: number;
  /** TCP connect, ms (median of 5). */
  connect: { anthropic: number; github: number; npm: number; pypi: number };
}

export const BENCH_DATE = "25 October 2026";

export const BENCHMARKS: SizeResult[] = [
  {
    size: "standard-1", location: "Paris (cdg10)", startFresh: 28.6, wake: 6.2, sleep: 24.4, snapshotMB: 172,
    webEcho: [24, 26], sshEcho: [31, 35], sshCommand: 0.6, sha1: 1232, shaAll: 550,
    sqliteCompile: 132.6, redisBuild: 384.0, npmInstall: 35.1, pythonLoop: 7.6,
    diskWrite: 62, diskRead: 705, netDown: 490, netUp: 479,
    connect: { anthropic: 7.1, github: 16.0, npm: 52.6, pypi: 7.4 },
  },
  {
    size: "standard-2", location: "Amsterdam (ams19)", startFresh: 5.4, wake: 4.8, sleep: 20.3, snapshotMB: 173,
    webEcho: [20, 25], sshEcho: [27, 39], sshCommand: 0.6, sha1: 1555, shaAll: 1484,
    sqliteCompile: 35.6, redisBuild: 108.8, npmInstall: 12.0, pythonLoop: 2.3,
    diskWrite: 199, diskRead: 4800, netDown: 697, netUp: 429,
    connect: { anthropic: 6.5, github: 17.4, npm: 5.2, pypi: 7.8 },
  },
  {
    size: "standard-3", location: "Amsterdam (ams19)", startFresh: 5.0, wake: 5.3, sleep: 165.1, snapshotMB: 173,
    webEcho: [23, 27], sshEcho: [26, 37], sshCommand: 0.4, sha1: 1606, shaAll: 2684,
    sqliteCompile: 34.5, redisBuild: 56.3, npmInstall: 12.3, pythonLoop: 2.4,
    diskWrite: 254, diskRead: 5200, netDown: 1638, netUp: 417,
    connect: { anthropic: 11.9, github: 15.4, npm: 8.8, pypi: 10.1 },
  },
  {
    size: "standard-4", location: "Amsterdam (ams19)", startFresh: 5.2, wake: 4.9, sleep: 26.4, snapshotMB: 154,
    webEcho: [22, 32], sshEcho: [34, 42], sshCommand: 0.4, sha1: 1560, shaAll: 6139,
    sqliteCompile: 32.3, redisBuild: 29.1, npmInstall: 9.7, pythonLoop: 2.4,
    diskWrite: 328, diskRead: 4700, netDown: 1290, netUp: 369,
    connect: { anthropic: 6.7, github: 13.2, npm: 7.0, pypi: 6.5 },
  },
];

/** What the workspaces run on, read from inside one (25 Oct 2026, standard-4, London). The VM hides
 *  the model name; the rest matches Cloudflare's Gen 12 servers (blog.cloudflare.com/gen-12-servers). */
export const HARDWARE: { item: string; value: string; evidence: string }[] = [
  { item: "Processor", value: "AMD EPYC 9684X \"Genoa-X\" (very likely)", evidence: "Cloudflare's Gen 12 servers use it; the details below match" },
  { item: "Generation", value: "4th-gen EPYC, Zen 4", evidence: "CPU family 25, model 17; AVX-512 with BF16; 1 MB L2 per core" },
  { item: "Cache", value: "96 MB L3 per chiplet (3D V-Cache)", evidence: "plain Genoa shows 32 MB; 1,152 MB per chip in total" },
  { item: "Clock", value: "2.55 GHz base", evidence: "the VM reports 2,550 MHz, the 9684X's base clock" },
  { item: "Virtualisation", value: "KVM virtual machine", evidence: "standard-4 shows 8 cores but is limited to 4 vCPUs of time" },
  { item: "Server", value: "96 cores, 384 GB DDR5, 16 TB NVMe, 2 x 25 GbE", evidence: "Cloudflare's published Gen 12 specification" },
];
