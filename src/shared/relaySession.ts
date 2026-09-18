// =====================================================================
// WHEN THE PAGE → IPC RELAY IS ARMED  (audit finding QF-002)
// =====================================================================
// The nonce that gates the relay has a small state machine around it, and
// getting it wrong does not look like a security bug — it looks like the
// recorder silently capturing nothing. Three ways that can happen:
//
//   · recording starts but no nonce is minted  → every step dropped
//   · a second recording reuses the first's nonce → a page that scraped the
//     old one can still post, which is the whole thing we were preventing
//   · the picker is treated as "not a session"  → picking an element to
//     assert on stops working, because it comes back through this same relay
//
// So the rule lives here, as a pure state machine, rather than inline in
// main's window setup where it could only be judged by running the app.
// `mint` is injected so a test can watch exactly when a new value is taken.
// =====================================================================

export interface RelaySession {
  /** The nonce to hand relays right now. '' means the relay is closed. */
  current(): string
  /**
   * Bring the nonce in line with what the app is doing.
   *
   * `fresh` mints a new value — a NEW session is beginning. Without it an
   * existing nonce is kept, so turning the picker on midway through a
   * recording doesn't invalidate the observers already running.
   *
   * Returns the nonce now in force.
   */
  sync(input: { recording: boolean; picking: boolean; fresh?: boolean }): string
}

export function createRelaySession(mint: () => string): RelaySession {
  let nonce = ''
  return {
    current: () => nonce,
    sync: ({ recording, picking, fresh = false }) => {
      if (recording || picking) {
        // `!nonce` covers the case a session is somehow active with nothing
        // armed — better to mint late than to record nothing at all.
        if (fresh || !nonce) nonce = mint()
      } else {
        // Neither recording nor picking: the page → IPC path is shut, which is
        // the state the app spends most of its life in.
        nonce = ''
      }
      return nonce
    }
  }
}
