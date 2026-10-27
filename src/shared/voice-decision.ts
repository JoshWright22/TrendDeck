// yes and no in what the creator says, typed or dictated. a short answer while an approval waits
// decides it (the composer, only from your own mic), and a message has to say one of these before
// the agent may press Keep or Drop on a card for you

const NO = /\b(no|nope|nah|deny|denied|don'?t|do not|stop|cancel|reject|drop|wait|hold on)\b/i
const YES = /\b(yes|yeah|yep|yup|sure|ok(ay)?|approve[ds]?|allow(ed)?|go ahead|do it|confirm(ed)?|accept(ed)?|keep|save|looks good|sounds good|that'?s fine|fine|good to go|go for it)\b/i

// a whole short answer: 'allow', 'deny' or null when it isn't one
export function shortAnswer(text: string): 'allow' | 'deny' | null {
  const t = text.trim().replace(/[.!?,]+$/g, '')
  if (!t || t.split(/\s+/).length > 6) return null
  if (NO.test(t)) return 'deny'
  if (YES.test(t)) return 'allow'
  return null
}

// a message that says to keep, approve, drop or reject something
export function saidYesOrNo(text: string): boolean {
  return YES.test(text) || /\b(drop|reject|remove|get rid of)\b/i.test(text)
}
