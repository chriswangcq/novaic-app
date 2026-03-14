/**
 * chatScrollRegistry.ts — Module-level registry for chat scroll actions.
 *
 * MessageList registers its scrollToBottom function here.
 * Any component (e.g. ChatInput) can call scrollToBottom without prop drilling.
 */

let _scrollToBottom: (() => void) | null = null;

export function registerScrollToBottom(fn: () => void) {
  _scrollToBottom = fn;
}

export function unregisterScrollToBottom() {
  _scrollToBottom = null;
}

export function scrollToBottom() {
  _scrollToBottom?.();
}
