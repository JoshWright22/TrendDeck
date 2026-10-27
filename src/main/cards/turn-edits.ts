import { TurnGroups } from '@shared/craft-embed'
import { webSpec } from '@shared/craft-web'
import { openApp } from '../craft'
import { waitForBridge } from '../craft/agent'
import { spec } from '../craft/catalog'
import { installed } from '../craft/install'
import { runningApp } from '../craft/launch'
import { appCall, onCraftEdit, type CraftEditCall } from '../craft/tools'
import { onTurnClosed } from '../mcp/turns'
import { checkpointFile, liveOn, upsertEmbed, whereOf } from './embed'
import { changeCard } from './store'

// the agent's edits in an app during one reply are one undo group: before the first one the app's
// file is copied aside (FilmCraft's file.saveCopy, so the user's unsaved changes are in it too),
// the reply's embed shows up and counts them, and Undo this turn puts the copy back

interface Group {
  cardId: string
  brandId: string
}

const groups = new TurnGroups<Group>()

async function start(c: CraftEditCall): Promise<Group> {
  const { turn, appId, projectId } = c
  // so the user watches the edits land: an app without an editor in the chat opens its window on
  // the project when it isn't open anywhere. one open on another project is left alone, the edits
  // run headless then. apps with a web build show in this reply's card instead (upsertEmbed below)
  if (!webSpec(appId) && spec(appId).bridgeArgs && !runningApp(appId) && (await installed(appId))) {
    try {
      await openApp({ appId, brandId: turn.brandId, projectId })
      await waitForBridge(appId)
    } catch (err) {
      console.error(`cards: couldn't open ${appId} for the agent's edits`, err)
    }
  }
  let checkpoint: string | null = null
  let note = ''
  try {
    checkpoint = (await checkpointFile(turn.brandId, projectId, appId, turn.id))?.rel ?? null
    if (!checkpoint) note = 'This is a new file, there is nothing from before to go back to.'
  } catch (err) {
    console.error('cards: no copy from before the edits', err)
    note = `No copy from before this reply could be made, use undo in ${spec(appId).name}.`
  }
  const card = await upsertEmbed(whereOf(turn), appId, projectId, (e) => {
    e.turn = { turnId: turn.id, edits: 0, state: 'working', checkpoint, note }
  }, { auto: true })
  return { cardId: card.id, brandId: turn.brandId }
}

export function setupTurnEdits(): void {
  onCraftEdit(
    async (c) => {
      await groups.open(c.turn.id, c.appId, c.projectId, () => start(c)).value
    },
    (c, ok) => {
      if (!ok) return
      const n = groups.edited(c.turn.id, c.appId, c.projectId)
      void groups
        .get(c.turn.id, c.appId, c.projectId)
        ?.then((g) =>
          changeCard(g.brandId, g.cardId, (e) => {
            if (e.type === 'craft' && e.turn && e.turn.turnId === c.turn.id) e.turn.edits = Math.max(e.turn.edits, n)
          })
        )
        .catch(() => {})
    }
  )
  onTurnClosed((turn) => {
    for (const g of groups.close(turn.id)) {
      const [, appId, projectId] = g.key.split('|')
      void g.value
        .then(async (grp) => {
          // the open window's project on disk gets the reply's edits, like the headless engine's
          const live = liveOn(appId, grp.brandId, projectId)
          if (g.edits > 0 && appId === 'filmcraft' && (live === 'window' || live === 'web')) {
            await appCall(grp.brandId, projectId, appId, 'command_run', { id: 'file.save', params: {} }).catch(() => {})
          }
          await changeCard(grp.brandId, grp.cardId, (e) => {
            if (e.type !== 'craft' || !e.turn || e.turn.turnId !== turn.id) return
            e.turn.edits = Math.max(e.turn.edits, g.edits)
            e.turn.state = e.turn.edits > 0 ? 'review' : 'failed'
            if (!e.turn.edits) e.turn.note = 'None of the edits went through.'
          })
        })
        .catch(() => {})
    }
  })
}
