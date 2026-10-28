// the chat follows the newest message until you scroll away from it. scrolls that aren't yours
// (the chat growing as images and editors size themselves) don't count, so a scroll the code does
// for you, like going to an editor or the wheel over one, is marked as yours here
export const USER_SCROLL_MS = 1000

export function markUserScroll(el: HTMLElement | null): void {
  if (el) el.dataset.userScroll = String(Date.now())
}

export function userScrolledRecently(el: HTMLElement, now = Date.now()): boolean {
  return now - Number(el.dataset.userScroll ?? 0) < USER_SCROLL_MS
}
