import type { ModelOption } from '@shared/chat'

// the agent clis we know how to run headless. each one gets the prompt in one go
// and prints its answer. claude keeps a session per thread, the rest start fresh

export interface CliSpec {
  id: string
  name: string
  // names to look for on PATH, first hit wins
  bins: string[]
  // stdin: prompt is piped in. arg: prompt replaces the {prompt} arg
  prompt: 'stdin' | 'arg'
  args: string[]
  // json event formats we can read thinking and tool calls from, text for the rest
  output: 'text' | 'claude-json' | 'codex-json' | 'cursor-json'
  // flag that picks the model, no flag means only the agent's default
  modelFlag?: string
  models?: ModelOption[]
  // args that resume a saved session, put before the rest
  resume?: (session: string) => string[]
  setup: string
  url: string
}

export const CLIS: CliSpec[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    bins: ['claude'],
    prompt: 'stdin',
    // web lookups only, no shell and no files. --strict-mcp-config keeps the user's own mcp servers out
    args: [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--strict-mcp-config',
      '--tools',
      'WebSearch,WebFetch',
      '--allowedTools',
      'WebSearch,WebFetch'
    ],
    output: 'claude-json',
    modelFlag: '--model',
    models: [
      { id: '', label: 'Default model' },
      { id: 'opus', label: 'Opus (latest)' },
      { id: 'sonnet', label: 'Sonnet (latest)' },
      { id: 'haiku', label: 'Haiku (latest)' },
      { id: 'claude-opus-5-5', label: 'Opus 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
      { id: 'claude-fable-5-1', label: 'Fable 5.1' }
    ],
    resume: (session) => ['--resume', session],
    setup: 'claude auth login',
    url: 'https://claude.com/product/claude-code'
  },
  {
    id: 'codex',
    name: 'Codex',
    bins: ['codex'],
    prompt: 'stdin',
    args: ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '-'],
    output: 'codex-json',
    modelFlag: '-m',
    models: [
      { id: '', label: 'Default model' },
      { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
      { id: 'gpt-5', label: 'GPT-5' }
    ],
    setup: 'codex login',
    url: 'https://developers.openai.com/codex/cli'
  },
  {
    id: 'cursor',
    name: 'Cursor',
    bins: ['agent', 'cursor-agent'],
    prompt: 'arg',
    args: ['-p', '--output-format', 'stream-json', '{prompt}'],
    output: 'cursor-json',
    modelFlag: '--model',
    models: [
      { id: '', label: 'Default model' },
      { id: 'auto', label: 'Auto' },
      { id: 'sonnet-4.5', label: 'Sonnet 4.5' },
      { id: 'gpt-5', label: 'GPT-5' }
    ],
    setup: 'agent login',
    url: 'https://cursor.com/cli'
  },
  {
    id: 'grok',
    name: 'Grok Build',
    bins: ['grok'],
    prompt: 'arg',
    args: ['--no-auto-update', '-p', '{prompt}'],
    output: 'text',
    setup: 'grok login',
    url: 'https://x.ai/cli'
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    bins: ['opencode'],
    prompt: 'stdin',
    args: ['run'],
    output: 'text',
    modelFlag: '-m',
    setup: 'opencode auth login',
    url: 'https://opencode.ai'
  },
  {
    id: 'agy',
    name: 'Antigravity',
    bins: ['agy'],
    prompt: 'arg',
    args: ['-p', '{prompt}'],
    output: 'text',
    setup: 'agy',
    url: 'https://antigravity.google'
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    bins: ['qwen'],
    prompt: 'arg',
    args: ['-p', '{prompt}'],
    output: 'text',
    modelFlag: '-m',
    setup: 'qwen',
    url: 'https://github.com/QwenLM/qwen-code'
  },
  {
    id: 'kimi',
    name: 'Kimi',
    bins: ['kimi'],
    prompt: 'arg',
    args: ['-p', '{prompt}'],
    output: 'text',
    setup: 'kimi',
    url: 'https://github.com/MoonshotAI/kimi-cli'
  }
]
