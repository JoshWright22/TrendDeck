import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { Page } from '../components/ComingSoon'
import type { PageProps } from './types'

// each page is its own chunk and only loads the first time you open it
const Stub = lazy(() => import('./Stub'))
const Trends = lazy(() => import('./Trends'))
const Ideas = lazy(() => import('./Ideas'))
const Voice = lazy(() => import('./voice/VoicePage'))

export const PAGE_VIEWS: Record<Page, LazyExoticComponent<ComponentType<PageProps>>> = {
  Trends,
  Ideas,
  Voice,
  Schedule: Stub,
  Writer: Stub,
  Analytics: Stub
}
