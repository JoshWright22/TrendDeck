import type { ReactNode } from 'react'
import ComingSoon from '../components/ComingSoon'
import PageHeader from '../components/PageHeader'
import type { PageProps } from './types'

export default function Stub({ page, chatOpen, onToggleChat }: PageProps): ReactNode {
  return (
    <div className="page">
      <PageHeader title={page} chatOpen={chatOpen} onToggleChat={onToggleChat} />
      <ComingSoon page={page} />
    </div>
  )
}
