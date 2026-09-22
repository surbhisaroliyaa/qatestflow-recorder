// =====================================================================
// THE DURABLE BACKGROUND RUNNER  (Phase 4, audit gap)
// =====================================================================
// THE LIMIT THIS CLOSES
//
// monitors.ts opens with: "HONEST LIMIT: monitors only fire while the app is
// open — there's no background service." That is the gap. A monitor that stops
// the moment someone closes the window isn't monitoring anything; it's a timer
// that happens to run tests.
//
// == Why the OS scheduler rather than a service of our own ==
//
// The obvious build is a background process that stays resident. It is also the
// wrong one for an INSTALLED desktop app, three times over:
//
//   · it has to survive reboots, user logouts and app updates — which is
//     precisely what the OS scheduler already does, correctly, and we would be
//     reimplementing badly;
//   · a resident process needs to start at login, which means an autostart
//     entry, which is the kind of thing that makes IT departments say no;
//   · it would be a SECOND runner to keep in step with the in-app one, and the
//     first time they drifted, "it passes in the app but fails at night" would
//     be the tool's fault rather than the app's.
//
// So the durable runner is: the OS scheduler, invoking the CLI (cli.ts) that
// already runs tests headlessly. One runner, one code path, and the scheduling
// is done by the thing on the machine whose job that is.
//
// == Windows only, and it says so ==
//
// Task Scheduler (schtasks) is Windows. macOS would need launchd and Linux a
// systemd timer or cron; both are straightforward and neither is written here,
// because writing them unverified would be worse than saying "not yet". The
// UI reports that plainly instead of failing at the point of use.
//
// == Everything here is pure ==
//
// Building a command line and reading schtasks' output are the parts with rules
// in them, and they are the parts a mistake is invisible in — a wrong quote
// makes a task that silently never runs. So they are pure functions, tested,
// and the actual spawning lives in index.ts.
// =====================================================================

/** The prefix every task this app creates shares, so its tasks can be found
 *  and removed without touching anything else in the user's scheduler. */
export const TASK_PREFIX = 'QATestFlow'

export interface ScheduledRun {
  /** The monitor this task runs — the id is what makes the task name unique. */
  monitorId: string
  /** For the task's description, so a human reading Task Scheduler can tell
   *  what it is without decoding the command. */
  testName: string
  /** How often, in minutes. */
  intervalMin: number
}

/** The task name for a monitor. Stable, so re-registering REPLACES rather than
 *  accumulating — the failure mode being a scheduler with forty copies of the
 *  same job in it, each running the same test. */
export function taskName(monitorId: string): string {
  // Task names can't contain these; a monitor id shouldn't either, but the id
  // is data and this function is the boundary.
  const safe = monitorId.replace(/[\\/:*?"<>|]/g, '')
  return `${TASK_PREFIX}-${safe}`
}

export interface SchtasksPlan {
  /** The executable to run — the installed app itself. */
  exe: string
  args: string[]
}

/**
 * Build the `schtasks /create` invocation for one monitor.
 *
 * The command it schedules is this app's own CLI. `--reporter junit --out`
 * is used rather than plain text because a scheduled run has nobody watching
 * stdout — and on Windows a GUI-subsystem app's stdout goes nowhere anyway, so
 * a file is the only place the result can actually land.
 *
 * Arguments are returned as an ARRAY, never a joined string. A path with a
 * space in it — `C:\Program Files\QATestFlow\…`, which is where this installs —
 * is the normal case, and string-joining it is how a scheduled task ends up
 * silently never running.
 */
export function buildCreateTask(
  run: ScheduledRun,
  exePath: string,
  reportPath: string
): SchtasksPlan {
  // schtasks takes minutes up to 1439 (a day); anything longer has to be
  // expressed as hours or days, and clamping is a lie. So the interval is
  // capped at a day here and the UI keeps monitors well under it.
  const minutes = Math.max(1, Math.min(1439, Math.round(run.intervalMin)))
  // The whole command must be ONE /TR argument. Windows requires the inner
  // quoting to be escaped, which is why this is built here and tested, rather
  // than assembled at the call site by hand.
  const command = [
    `"${exePath}"`,
    'run',
    '--grep',
    `"${run.testName.replace(/"/g, '')}"`,
    // So the background run lands in this monitor's history. Without it the
    // feature's whole output was one report file that each run overwrote, and
    // the app showed nothing at all for runs made while it was closed.
    '--monitor',
    `"${run.monitorId.replace(/"/g, '')}"`,
    '--reporter',
    'junit',
    '--out',
    `"${reportPath}"`
  ].join(' ')

  return {
    exe: 'schtasks',
    args: [
      '/create',
      '/f', // replace an existing task of the same name rather than erroring
      '/tn',
      taskName(run.monitorId),
      '/sc',
      'minute',
      '/mo',
      String(minutes),
      '/tr',
      command
    ]
  }
}

export function buildDeleteTask(monitorId: string): SchtasksPlan {
  return { exe: 'schtasks', args: ['/delete', '/f', '/tn', taskName(monitorId)] }
}

export function buildQueryTasks(): SchtasksPlan {
  // CSV, because the human-readable table is localised — on a German Windows
  // the column headers and the "Ready" state come back in German, and any
  // parsing of it would work on the developer's machine and nowhere else.
  return { exe: 'schtasks', args: ['/query', '/fo', 'CSV', '/nh'] }
}

/**
 * Read `schtasks /query /fo CSV /nh` output and return OUR task names.
 *
 * Only names carrying the prefix are returned: everything else in that list
 * belongs to the user or to Windows, and this app has no business reporting on
 * it, let alone removing it.
 */
export function parseTaskList(csv: string): string[] {
  const out: string[] = []
  for (const line of (csv ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue
    // The first CSV field is the task name, quoted, and Windows presents it
    // with a leading backslash for the root folder.
    const match = /^"([^"]*)"/.exec(line.trim())
    if (!match) continue
    const name = match[1].replace(/^\\+/, '')
    if (name.startsWith(`${TASK_PREFIX}-`)) out.push(name)
  }
  return out
}

/** Is a durable background run available on this platform? Answered honestly
 *  rather than attempted and failed at the point of use. */
export function schedulerAvailable(platform: string = process.platform): boolean {
  return platform === 'win32'
}

export function unavailableMessage(platform: string = process.platform): string {
  if (platform === 'darwin') {
    return 'Running with the app closed needs a macOS launchd agent, which this build does not create yet. Monitors still run while the app is open.'
  }
  if (platform === 'linux') {
    return 'Running with the app closed needs a systemd timer, which this build does not create yet. Monitors still run while the app is open.'
  }
  return 'Running with the app closed is not supported on this platform yet. Monitors still run while the app is open.'
}
