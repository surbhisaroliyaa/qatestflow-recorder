import { describe, it, expect } from 'vitest'
import {
  TASK_PREFIX,
  buildCreateTask,
  buildDeleteTask,
  buildQueryTasks,
  parseTaskList,
  schedulerAvailable,
  taskName,
  unavailableMessage
} from '../src/main/scheduler'

// =====================================================================
// The durable background runner.
//
// Everything here fails INVISIBLY when it is wrong. A mis-quoted path makes a
// scheduled task that is created successfully, appears in Task Scheduler, and
// silently never runs — and nobody finds out, because the whole point is that
// nobody is watching. That is why the command construction is a pure function
// with tests rather than a string built at the call site.
//
// The path this app actually installs to is `C:\Program Files\QATestFlow
// Recorder\…`, which contains a space. Every case below uses a path with a
// space in it for that reason: the happy path IS the hard case.
// =====================================================================

const EXE = 'C:\\Program Files\\QATestFlow Recorder\\QATestFlow Recorder.exe'
const REPORT = 'C:\\Users\\qa\\Documents\\QATestFlow Tests\\_reports\\nightly.xml'

describe('§ task names', () => {
  it('is stable for a monitor, so re-registering REPLACES', () => {
    // Without this, turning a monitor off and on again leaves the scheduler
    // with two copies of the same job, then three — each running the test.
    expect(taskName('mon-1')).toBe(taskName('mon-1'))
    expect(taskName('mon-1')).not.toBe(taskName('mon-2'))
  })

  it('carries the prefix, so our tasks are identifiable', () => {
    expect(taskName('mon-1').startsWith(`${TASK_PREFIX}-`)).toBe(true)
  })

  it('strips characters a task name cannot contain', () => {
    expect(taskName('a/b\\c:d*e?f"g<h>i|j')).toBe(`${TASK_PREFIX}-abcdefghij`)
  })
})

describe('§ the created task', () => {
  const plan = buildCreateTask(
    { monitorId: 'mon-7', testName: 'Checkout smoke', intervalMin: 30 },
    EXE,
    REPORT
  )

  it('passes arguments as an array, never a joined string', () => {
    // The installed path has a space in it. Joining these into one string is
    // exactly how a task gets created and then never runs.
    expect(Array.isArray(plan.args)).toBe(true)
    expect(plan.exe).toBe('schtasks')
  })

  it('replaces an existing task of the same name instead of erroring', () => {
    expect(plan.args).toContain('/f')
  })

  it('schedules by the minute, with the interval', () => {
    expect(plan.args).toContain('/sc')
    expect(plan.args[plan.args.indexOf('/sc') + 1]).toBe('minute')
    expect(plan.args[plan.args.indexOf('/mo') + 1]).toBe('30')
  })

  it('quotes the executable path inside the command', () => {
    const cmd = plan.args[plan.args.indexOf('/tr') + 1]
    expect(cmd).toContain(`"${EXE}"`)
  })

  it('writes a JUnit report to a FILE', () => {
    // A scheduled run has nobody watching stdout — and on Windows a GUI-subsystem
    // app's stdout goes nowhere at all. A file is the only place the result can
    // actually land, so a run with no --out would be a run with no result.
    const cmd = plan.args[plan.args.indexOf('/tr') + 1]
    expect(cmd).toContain('--reporter junit')
    expect(cmd).toContain(`--out "${REPORT}"`)
  })

  it('runs the CLI, not some second runner', () => {
    // One runner, one code path. A separate night-time runner would drift, and
    // "passes in the app, fails at night" would be the tool's fault.
    const cmd = plan.args[plan.args.indexOf('/tr') + 1]
    expect(cmd).toContain(' run ')
  })

  it('keeps a test name with a quote in it from breaking the command', () => {
    const nasty = buildCreateTask(
      { monitorId: 'm', testName: 'The "big" flow', intervalMin: 5 },
      EXE,
      REPORT
    )
    const cmd = nasty.args[nasty.args.indexOf('/tr') + 1]
    // The inner quotes are gone rather than left to terminate the argument
    // early and turn the rest of the command into something else.
    expect(cmd).toContain('--grep "The big flow"')
  })

  it('clamps the interval to what schtasks actually accepts', () => {
    // /sc minute tops out at 1439. A larger number is rejected by schtasks, so
    // a "once a week" monitor would silently fail to register.
    const long = buildCreateTask(
      { monitorId: 'm', testName: 'T', intervalMin: 10_000 },
      EXE,
      REPORT
    )
    expect(long.args[long.args.indexOf('/mo') + 1]).toBe('1439')
    const zero = buildCreateTask({ monitorId: 'm', testName: 'T', intervalMin: 0 }, EXE, REPORT)
    expect(zero.args[zero.args.indexOf('/mo') + 1]).toBe('1')
  })
})

describe('§ removing a task', () => {
  it('deletes by the same name it created, without prompting', () => {
    const plan = buildDeleteTask('mon-7')
    expect(plan.args).toEqual(['/delete', '/f', '/tn', taskName('mon-7')])
  })
})

describe('§ listing tasks', () => {
  it('asks for CSV, not the human table', () => {
    // The readable table is LOCALISED — on a German Windows the headers and the
    // "Ready" state come back in German. Parsing it would work on one machine.
    expect(buildQueryTasks().args).toEqual(['/query', '/fo', 'CSV', '/nh'])
  })

  it('returns only OUR tasks', () => {
    // Everything else in that list belongs to the user or to Windows. Reporting
    // on it would be rude; removing it would be a catastrophe.
    const csv = [
      '"\\Microsoft\\Windows\\Defrag\\ScheduledDefrag","28/09/2026 01:00:00","Ready"',
      `"\\${TASK_PREFIX}-mon-1","21/09/2026 15:00:00","Ready"`,
      `"\\${TASK_PREFIX}-mon-2","21/09/2026 15:30:00","Ready"`,
      '"\\SomeoneElsesJob","N/A","Disabled"'
    ].join('\r\n')
    expect(parseTaskList(csv)).toEqual([`${TASK_PREFIX}-mon-1`, `${TASK_PREFIX}-mon-2`])
  })

  it('survives empty and malformed output', () => {
    expect(parseTaskList('')).toEqual([])
    expect(parseTaskList('\r\n\r\n')).toEqual([])
    expect(parseTaskList('not csv at all')).toEqual([])
  })
})

describe('§ platforms it does not support', () => {
  it('is available on Windows', () => {
    expect(schedulerAvailable('win32')).toBe(true)
  })

  it('says so plainly elsewhere, rather than failing at the point of use', () => {
    // Sameer ran the audit on macOS. A feature that claims to work and then
    // doesn't is worse than one that says what it can't do.
    expect(schedulerAvailable('darwin')).toBe(false)
    expect(schedulerAvailable('linux')).toBe(false)
    expect(unavailableMessage('darwin')).toMatch(/launchd/)
    expect(unavailableMessage('linux')).toMatch(/systemd/)
    // And each one still says what DOES work today.
    expect(unavailableMessage('darwin')).toMatch(/while the app is open/)
  })
})
