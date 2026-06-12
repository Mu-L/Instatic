/**
 * SeoScoreboard — the Meta tab's control-center band: site-wide SEO score
 * in a liquid-progress ring plus coverage tiles, all derived from the same
 * per-target reports the index renders.
 *
 * Tiles follow the borderless card pattern (surface-2 cells over a darker
 * surface parent with a 1px grid gap). The issues tile carries the one
 * action — jump the index to the issues filter.
 */
import { Button } from '@ui/components/Button'
import { LiquidProgressRing } from '@ui/components/LiquidProgressRing'
import { aggregateSeoScore, seoScoreTier, type SeoCheckId } from '@core/seo'
import { cn } from '@ui/cn'
import type { IndexedSeoTarget } from '../lib/indexTargets'
import styles from './SeoScoreboard.module.css'

interface SeoScoreboardProps {
  indexed: IndexedSeoTarget[]
  onReviewIssues: () => void
}

const TIER_TONE = { good: 'mint', fair: 'amber', poor: 'danger' } as const

const TIER_HEADLINE = {
  good: 'Looking sharp — keep it green.',
  fair: 'Solid base — a few targets need attention.',
  poor: 'Search engines are flying blind — start with titles and descriptions.',
} as const

function passCount(indexed: IndexedSeoTarget[], ids: SeoCheckId[]): number {
  return indexed.filter(({ report }) =>
    ids.every((id) => {
      const check = report.checks.find((c) => c.id === id)
      // Omitted checks (alt with no image) don't count as covered.
      return check !== undefined && check.status === 'pass'
    }),
  ).length
}

export function SeoScoreboard({ indexed, onReviewIssues }: SeoScoreboardProps) {
  const total = indexed.length
  const score = aggregateSeoScore(indexed.map(({ report }) => report))
  const tier = seoScoreTier(score)

  const searchReady = passCount(indexed, ['title', 'description'])
  const socialReady = passCount(indexed, ['socialImage', 'imageAlt'])
  const indexable = passCount(indexed, ['indexable'])
  const issues = indexed.filter(({ report }) => report.issueCount > 0).length

  return (
    <section className={styles.scoreboard} aria-label="Site SEO score">
      <div className={cn(styles.cell, styles.scoreCell)}>
        <LiquidProgressRing
          value={score}
          total={100}
          size={88}
          tone={TIER_TONE[tier]}
          label={<span className={styles.scoreValue}>{score}</span>}
          ariaLabel={`Site SEO score: ${score} out of 100`}
        />
        <div className={styles.scoreText}>
          <h3 className={styles.scoreTitle}>Site SEO score</h3>
          <p className={styles.scoreHeadline}>{TIER_HEADLINE[tier]}</p>
          <p className={styles.scoreSub}>
            Average across {total} {total === 1 ? 'target' : 'targets'} — weighted checks on
            titles, descriptions, social cards, and indexability.
          </p>
        </div>
      </div>

      <div className={cn(styles.cell, styles.tile)}>
        <span className={styles.tileValue} data-good={searchReady === total || undefined}>
          {searchReady}<span className={styles.tileTotal}>/{total}</span>
        </span>
        <span className={styles.tileLabel}>Search snippets</span>
        <span className={styles.tileHint}>Title and description in the ideal band</span>
      </div>

      <div className={cn(styles.cell, styles.tile)}>
        <span className={styles.tileValue} data-good={socialReady === total || undefined}>
          {socialReady}<span className={styles.tileTotal}>/{total}</span>
        </span>
        <span className={styles.tileLabel}>Social cards</span>
        <span className={styles.tileHint}>Image with alt text for link shares</span>
      </div>

      <div className={cn(styles.cell, styles.tile)}>
        <span className={styles.tileValue} data-good={indexable === total || undefined}>
          {indexable}<span className={styles.tileTotal}>/{total}</span>
        </span>
        <span className={styles.tileLabel}>Indexable</span>
        <span className={styles.tileHint}>Visible to search and answer engines</span>
      </div>

      <div className={cn(styles.cell, styles.tile)}>
        <span className={styles.tileValue} data-attention={issues > 0 || undefined}>
          {issues}
        </span>
        <span className={styles.tileLabel}>{issues === 1 ? 'Target needs work' : 'Targets need work'}</span>
        {issues > 0 ? (
          <Button
            variant="ghost"
            size="xs"
            className={styles.tileAction}
            onClick={onReviewIssues}
            data-testid="seo-scoreboard-review-issues"
          >
            Review issues
          </Button>
        ) : (
          <span className={styles.tileHint}>Nothing flagged right now</span>
        )}
      </div>
    </section>
  )
}
