import type { Brand } from '@shared/types'
import type { Page } from '../components/ComingSoon'

export interface PageProps {
  page: Page
  brand: Brand
  editBrand: (fn: (b: Brand) => Brand) => void
  onEditBrand: () => void
  chatOpen: boolean
  onToggleChat: () => void
}
