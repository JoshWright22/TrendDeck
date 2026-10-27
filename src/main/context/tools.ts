import { STYLE_RULE_CHARS, STYLE_RULE_MAX, STYLE_WHY_CHARS } from '@shared/context'
import { brandOf, iso } from '../gateway/tools/common'
import { ToolError, type GatewayTool } from '../gateway/types'
import { int, obj, str } from '../gateway/validate'
import { searchTexts } from './docs'
import { addRule, cleanRule, type RuleResult } from './rules'
import { changeContext, changed, docsIndex, isIndexing, loadContext, transcripts } from './store'

const NO_FOLDER =
  "The user hasn't picked a brand docs folder yet. They can pick one in Settings, under Context. Until then there are no brand docs to read."

const query = str('Words to look for.', 200, 1)
const limit = int('How many matches to return, 5 when left out.', 1, 20)

export const CONTEXT_TOOLS: GatewayTool[] = [
  {
    name: 'brand_docs_search',
    title: 'Search brand docs',
    risk: 'read',
    description:
      "Search the brand's own docs (markdown, text and pdf files in the folder the user picked) for words. Returns the best matching files with a snippet around the best hit. Use brand_docs_read to read one in full.",
    inputSchema: obj({ query, limit }, ['query']),
    run: async (turn, args) => {
      brandOf(turn)
      const { folder, index } = await docsIndex(turn.brandId)
      if (!folder) return NO_FOLDER
      if (!index || !index.files.length) {
        return isIndexing(turn.brandId) ? 'The brand docs folder is still being indexed. Try again in a moment.' : 'The brand docs folder has no markdown, text or pdf files.'
      }
      const items = index.files.filter((f) => f.text).map((f) => ({ name: f.file, text: f.text }))
      if (!items.length) return 'No text found in the brand docs. The pdfs may be scanned images.'
      const hits = searchTexts(items, args.query as string, (args.limit as number | undefined) ?? 5)
      if (!hits.length) return `Nothing in the brand docs matches "${args.query as string}".`
      return { matches: hits.map((h) => ({ file: h.item.name, score: h.score, snippet: h.snippet })), indexedFiles: index.files.length }
    }
  },
  {
    name: 'brand_docs_read',
    title: 'Read a brand doc',
    risk: 'read',
    description: 'Read the text of one brand doc, by the file name brand_docs_search gave (relative to the docs folder).',
    inputSchema: obj(
      {
        file: str('File name as brand_docs_search returned it.', 500, 1),
        maxChars: int('Most characters to return, 8000 when left out.', 200, 20000)
      },
      ['file']
    ),
    run: async (turn, args) => {
      brandOf(turn)
      const { folder, index } = await docsIndex(turn.brandId)
      if (!folder) return NO_FOLDER
      const name = (args.file as string).replace(/\\/g, '/').replace(/^\.\//, '')
      const doc = index?.files.find((f) => f.file === name) ?? index?.files.find((f) => f.file.toLowerCase() === name.toLowerCase())
      if (!doc) throw new ToolError(`There's no indexed brand doc called "${name}". Use brand_docs_search to find file names.`)
      if (!doc.text) return `No text found in ${doc.file}. It may be a scanned pdf.`
      const max = (args.maxChars as number | undefined) ?? 8000
      return {
        file: doc.file,
        chars: doc.text.length,
        truncated: doc.text.length > max,
        text: doc.text.length > max ? doc.text.slice(0, max) : doc.text
      }
    }
  },
  {
    name: 'past_videos_search',
    title: 'Search past video transcripts',
    risk: 'read',
    description:
      "Search transcripts and captions (.srt, .vtt, and transcript .txt files) of this brand's past videos, from its project folders. Returns the project, the file and a snippet.",
    inputSchema: obj({ query, limit }, ['query']),
    run: async (turn, args) => {
      brandOf(turn)
      const list = (await transcripts(turn.brandId)).filter((t) => t.text)
      if (!list.length) return "No transcripts or caption files were found in this brand's project folders."
      const items = list.map((t) => ({ name: `${t.project}/${t.file}`, text: t.text, project: t.project, file: t.file }))
      const hits = searchTexts(items, args.query as string, (args.limit as number | undefined) ?? 5)
      if (!hits.length) return `No past video transcript matches "${args.query as string}".`
      return { matches: hits.map((h) => ({ project: h.item.project, file: h.item.file, score: h.score, snippet: h.snippet })), transcripts: list.length }
    }
  },
  {
    name: 'style_rules_list',
    title: 'List style rules',
    risk: 'read',
    description: 'List the style rules the user confirmed for this brand, newest first.',
    inputSchema: obj(),
    run: async (turn) => {
      brandOf(turn)
      const { rules } = await loadContext(turn.brandId)
      if (!rules.length) return 'No style rules saved for this brand yet.'
      return {
        rules: [...rules]
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((r) => ({ text: r.text, from: r.source === 'agent' ? 'suggested by an agent' : 'added by the user', savedAt: iso(r.createdAt), ...(r.why ? { why: r.why } : {}) })),
        max: STYLE_RULE_MAX
      }
    }
  },
  {
    name: 'remember_style',
    title: 'Remember a style rule',
    risk: 'edit',
    alwaysAsk: true,
    description: `Ask the user to save a short style rule for this brand, e.g. "Cut every pause longer than 0.4 s". The user approves each one. Saved rules are shown to you on every turn. Up to ${STYLE_RULE_MAX} rules, ${STYLE_RULE_CHARS} characters each.`,
    inputSchema: obj(
      {
        rule: str('The rule, one short sentence.', STYLE_RULE_CHARS, 1),
        why: str('Why you suggest it, shown to the user.', STYLE_WHY_CHARS)
      },
      ['rule']
    ),
    summarize: (turn, args) => `Remember for ${brandOf(turn).name}: "${cleanRule(args.rule)}"`,
    run: async (turn, args) => {
      brandOf(turn)
      const result = await changeContext<RuleResult>(turn.brandId, (file) => {
        const r = addRule(file.rules, args.rule, 'agent', { why: args.why })
        return r.ok ? { file: { ...file, rules: r.rules }, out: r } : { file, out: r }
      })
      if (!result.ok) throw new ToolError(result.error)
      changed(turn.brandId)
      return { saved: result.rule.text, rules: result.rules.length, max: STYLE_RULE_MAX }
    }
  }
]
