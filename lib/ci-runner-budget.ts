/**
 * Timing headroom for the free GitHub-hosted 2 vCPU runner.
 * Local runs leave the variable unset and keep the original budgets.
 */
export function slowCiRunner(env: Record<string, string | undefined> = process.env): boolean {
  return env.AEGIS_CI_SLOW_RUNNER === "1";
}

/**
 * Two animation frames after a map click. Local budget stays 500ms.
 * Run 39540682612 measured 589ms for the medium import on ubuntu-24.04.
 */
export function clickLatencyBudgetMs(env: Record<string, string | undefined> = process.env): number {
  return slowCiRunner(env) ? 2_000 : 500;
}

/**
 * Wall-clock limit for one stress test. The huge import reached CA-5
 * (control 70 of 323) at the 10 minute mark while three browsers shared
 * two CPUs. One browser on that runner needs more than 10 minutes.
 */
export function stressTestTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  return slowCiRunner(env) ? 2_400_000 : 600_000;
}
