import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { Page } from '../components/ComingSoon'
import type { PageProps } from './types'

// each page is its own chunk and only loads the first time you open it
const Trends = lazy(() => import('./Trends'))
const Ideas = lazy(() => import('./ideas/IdeasBoard'))
const Schedule = lazy(() => import('./schedule/SchedulePage'))
const Writer = lazy(() => import('./writer/Writer'))
const Analytics = lazy(() => import('./analytics/Analytics'))
const Posting = lazy(() => import('../posting/PostingPage'))
const Media = lazy(() => import('./media/MediaPage'))
const Voice = lazy(() => import('./voice/VoicePage'))
const Inbox = lazy(() => import('./inbox/InboxPage'))
const Shorts = lazy(() => import('./reuse/ShortsPage'))

export const PAGE_VIEWS: Record<Page, LazyExoticComponent<ComponentType<PageProps>>> = {
  Trends,
  Ideas,
  Voice,
  Media,
  Schedule,
  Writer,
  Analytics,
  Posting,
  Shorts,
  Inbox
}
