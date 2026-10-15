/**
 * sdk-forward.js: which live Claude Code (SDK) messages the engine sends on to windows and phones (2026-10-15).
 *
 * Arthur: "our apaki app gets kind of laggy with multiple tabs and panes running at the same time". The window's
 * profile showed its main thread busy; part of that was traffic it throws away on arrival. pane.js onSdk drops every
 * message with a parent_tool_use_id (a subagent's own messages, often large tool results; the Tasks viewer tails the
 * subagent's transcript instead) and draws only text deltas while a reply streams, so thinking and tool-input deltas,
 * sent token by token, were serialized here, sent, parsed on the window's main thread (and over the relay to a phone)
 * for nothing. The engine itself still sees every message (paneActivity, the context meter, asks); only what goes out
 * to clients is filtered. A client that starts to use these needs this list changed with it.
 */

/** True when windows and phones use this live SDK message. */
export function forwardToClients(msg) {
  if (!msg || typeof msg !== 'object') return true;
  // A subagent's own traffic: dropped by pane.js on arrival.
  if (msg.parent_tool_use_id) return false;
  // Streaming pieces of thinking, signatures and tool input: pane.js draws only text_delta as a reply streams.
  if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta' && msg.event.delta?.type !== 'text_delta') return false;
  return true;
}
