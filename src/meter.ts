// Cost estimation for Cloudflare Containers, from our own metering.
// Prices: developers.cloudflare.com/containers/pricing (checked 24 Oct 2026). CPU is billed on
// active use; memory and disk on the provisioned instance while it runs. Snapshot storage and
// Workers/DO request charges are not modelled (small, and not published for snapshots).

export const INSTANCES: Record<string, { vcpu: number; memGiB: number; diskGB: number }> = {
  lite: { vcpu: 1 / 16, memGiB: 0.25, diskGB: 2 },
  basic: { vcpu: 0.25, memGiB: 1, diskGB: 4 },
  "standard-1": { vcpu: 0.5, memGiB: 4, diskGB: 8 },
  "standard-2": { vcpu: 1, memGiB: 6, diskGB: 12 },
  "standard-3": { vcpu: 2, memGiB: 8, diskGB: 16 },
  "standard-4": { vcpu: 4, memGiB: 12, diskGB: 20 },
};

/** Sizes a workspace can use, smallest first, and what each suits. The two smaller predefined
 *  types (256 MiB, 1 GiB) cannot run Claude beside the agent browser; Cloudflare's largest by
 *  default is standard-4 (custom types share its limits). */
export const SIZES: Record<string, string> = {
  "standard-1": "Light work: editing, one agent on a small repo. The agent browser is slow.",
  "standard-2": "Everyday: Claude with the agent browser on a typical project.",
  "standard-3": "Builds and test suites, or two or three agents working at once.",
  "standard-4": "Heavy builds, large repos, several busy agents. The largest available.",
};

export const PRICE = {
  vcpuSecond: 0.00002,
  gibSecond: 0.0000025,
  gbSecond: 0.00000007,
  plan: 5, // Workers Paid, per month, account-wide
  included: { vcpuSeconds: 375 * 60, gibSeconds: 25 * 3600, gbSeconds: 200 * 3600 },
};

/** Usage for one workspace in one calendar month (UTC). */
export interface Usage {
  runSeconds: number;
  cpuSeconds: number;
  gibSeconds: number;
  gbSeconds: number;
  starts: number;
  snapshots: number;
  lastSnapshotBytes: number;
}

export const emptyUsage = (): Usage => ({
  runSeconds: 0, cpuSeconds: 0, gibSeconds: 0, gbSeconds: 0, starts: 0, snapshots: 0, lastSnapshotBytes: 0,
});

export const month = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);

export function cost(u: Usage) {
  const cpu = u.cpuSeconds * PRICE.vcpuSecond;
  const memory = u.gibSeconds * PRICE.gibSecond;
  const disk = u.gbSeconds * PRICE.gbSecond;
  return { cpu, memory, disk, total: cpu + memory + disk };
}

/** Account-level month bill: usage summed across workspaces, minus included allowances, plus plan. */
export function bill(all: Usage[]) {
  const sum = all.reduce((a, u) => {
    a.cpuSeconds += u.cpuSeconds; a.gibSeconds += u.gibSeconds; a.gbSeconds += u.gbSeconds;
    return a;
  }, emptyUsage());
  const gross = cost(sum);
  const over = {
    cpu: Math.max(0, sum.cpuSeconds - PRICE.included.vcpuSeconds) * PRICE.vcpuSecond,
    memory: Math.max(0, sum.gibSeconds - PRICE.included.gibSeconds) * PRICE.gibSecond,
    disk: Math.max(0, sum.gbSeconds - PRICE.included.gbSeconds) * PRICE.gbSecond,
  };
  const usageAfterIncluded = over.cpu + over.memory + over.disk;
  return { gross, usageAfterIncluded, plan: PRICE.plan, total: usageAfterIncluded + PRICE.plan };
}

/** Cost of one hour running this instance at a given average CPU utilisation (0..1). */
export function hourly(instance: string, cpuUtil: number) {
  const i = INSTANCES[instance] ?? INSTANCES["standard-2"];
  return 3600 * (i.vcpu * cpuUtil * PRICE.vcpuSecond + i.memGiB * PRICE.gibSecond + i.diskGB * PRICE.gbSecond);
}
