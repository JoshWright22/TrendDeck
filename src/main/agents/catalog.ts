// the agent clis we know how to run headless. each one gets the whole prompt
// in one go and prints its answer, nothing is kept between runs

export interface CliSpec {
  id: string
  name: string
  // names to look for on PATH, first hit wins
  bins: string[]
  // stdin: prompt is piped in. arg: prompt replaces the {prompt} arg
  prompt: 'stdin' | 'arg'
  args: string[]
  // claude prints json events, the rest print plain text
  output: 'text' | 'claude-json'
  setup: string
  url: string
}

export const CLIS: CliSpec[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    bins: ['claude'],
    prompt: 'stdin',
    // no tools, it only has to write text back
    args: [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--no-session-persistence',
      '--tools',
      ''
    ],
    output: 'claude-json',
    setup: 'claude auth login',
    url: 'https://claude.com/product/claude-code'
  },
  {
    id: 'codex',
    name: 'Codex',
    bins: ['codex'],
    prompt: 'stdin',
    args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '-'],
    output: 'text',
    setup: 'codex login',
    url: 'https://developers.openai.com/codex/cli'
  },
  {
    id: 'cursor',
    name: 'Cursor',
    bins: ['agent', 'cursor-agent'],
    prompt: 'arg',
    args: ['-p', '--output-format', 'text', '{prompt}'],
    output: 'text',
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
