/**
 * DepsSection — dependency management content.
 *
 * Behaviour:
 *   - SAFE_PACKAGE_NAME validation on every add (Constraint #361 Rule 5 / CWE-78)
 *   - Inline remove confirmation (Guideline #258)
 *   - Search with aria-live result count (WCAG 2.1 AA)
 *   - setDependency / removeDependency store actions
 *
 * When used as a standalone Dependencies panel, the body is always visible.
 * The collapsible mode remains available for any compact embedded surface.
 *
 * @see Constraint #361 — Phase G Security (Rule 5: package-name validation, CWE-78)
 * @see Guideline #258 — Inline Confirmation UI Pattern
 * @see Contribution #512 — Phase E+ Site Panel UX Spec §4
 */
import { useState, useRef, useCallback, useMemo } from 'react'
import { useEditorStore } from '@core/editor-store/store'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { SearchBar } from '@ui/components/SearchBar'
import { Switch } from '@ui/components/Switch'
import { PackageIcon } from '@ui/icons/icons/package'
import { PlusIcon } from '@ui/icons/icons/plus'
import { CloseIcon } from '@ui/icons/icons/close'
import { ChevronRightIcon } from '@ui/icons/icons/chevron-right'
import { cn } from '@ui/cn'
import { isSafePackageName } from '@core/site-dependencies/packageNames'
import {
  getSiteModuleDependencyUsage,
  type SiteModuleDependencyUsage,
} from '@core/module-engine/dependencies'
import {
  analyzeRuntimeScriptImports,
  type RuntimePackageDependencyUsage,
  type SiteRuntimeDiagnostic,
} from '@core/site-runtime'
import { resolveCmsRuntimeDependencies } from '@core/persistence/cmsRuntime'
import { registry } from '@core/module-engine/registry'
import { describeLockStatus, evaluateDependencyLockStatus } from './lockStatus'
import styles from './DepsSection.module.css'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RemoveConfirmState {
  name: string
  /** TODO(Phase G): used by `bun remove --dev` when bridge is active */
  dev: boolean
}

interface DependencyUsageSummary {
  moduleUsage?: SiteModuleDependencyUsage
  scriptUsage?: RuntimePackageDependencyUsage
}

interface RuntimeDependencyIssue {
  code: string
  packageName: string
  message: string
  action: 'add' | 'move-to-runtime' | null
}

// ---------------------------------------------------------------------------
// DepsSection
// ---------------------------------------------------------------------------

interface DepsSectionProps {
  collapsible?: boolean
  defaultExpanded?: boolean
}

export function DepsSection({
  collapsible = true,
  defaultExpanded = false,
}: DepsSectionProps) {
  const site = useEditorStore((s) => s.site)
  const packageJson = useEditorStore((s) => s.packageJson)
  const siteRuntime = useEditorStore((s) => s.siteRuntime)
  const setDependency = useEditorStore((s) => s.setDependency)
  const removeDependency = useEditorStore((s) => s.removeDependency)
  const setSiteDependencyLock = useEditorStore((s) => s.setSiteDependencyLock)

  // ── Section collapse state ───────────────────────────────────────────────
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  // ── Local state ─────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('')
  const [addName, setAddName] = useState('')
  const [addDev, setAddDev] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [resolveStatus, setResolveStatus] = useState<'idle' | 'resolving' | 'resolved' | 'error'>('idle')
  const [resolveMessage, setResolveMessage] = useState<string | null>(null)
  const [removeConfirm, setRemoveConfirm] = useState<RemoveConfirmState | null>(null)

  const cancelRef = useRef<HTMLButtonElement>(null)

  // ── Filtered deps ────────────────────────────────────────────────────────
  const filterDeps = useCallback(
    (deps: Record<string, string>) => {
      if (!searchQuery.trim()) return Object.entries(deps)
      const q = searchQuery.toLowerCase()
      return Object.entries(deps).filter(([name]) => name.toLowerCase().includes(q))
    },
    [searchQuery],
  )

  const filteredDeps = useMemo(
    () => filterDeps(packageJson.dependencies),
    [filterDeps, packageJson.dependencies],
  )
  const filteredDevDeps = useMemo(
    () => filterDeps(packageJson.devDependencies),
    [filterDeps, packageJson.devDependencies],
  )
  const dependencyUsage = useMemo(
    () => combineDependencyUsage(
      getSiteModuleDependencyUsage(site, registry),
      analyzeRuntimeScriptImports(site?.files ?? [], packageJson).usage,
    ),
    [packageJson, site],
  )
  const runtimeIssues = useMemo(
    () => summarizeRuntimeDependencyIssues(
      analyzeRuntimeScriptImports(site?.files ?? [], packageJson).diagnostics,
    ),
    [packageJson, site],
  )

  const totalFiltered = filteredDeps.length + filteredDevDeps.length
  const totalAll =
    Object.keys(packageJson.dependencies).length +
    Object.keys(packageJson.devDependencies).length

  const lockedPackages = siteRuntime.dependencyLock.packages
  const lockStatus = useMemo(
    () => evaluateDependencyLockStatus(packageJson, lockedPackages),
    [packageJson, lockedPackages],
  )

  // Suppress the manual resolve toast whenever the lock status falls out of
  // sync (e.g. user added another package after a successful resolve).
  // Derived during render so we don't need a useEffect to mutate state in
  // response to a prop change. The underlying state is left alone — only the
  // surfaced view is hidden.
  const isResolveToastStale =
    lockStatus.kind !== 'in-sync' && resolveStatus === 'resolved'
  const displayedResolveStatus = isResolveToastStale ? 'idle' : resolveStatus
  const displayedResolveMessage = isResolveToastStale ? null : resolveMessage

  // ── Add package handler ──────────────────────────────────────────────────
  const handleAddPackage = useCallback(() => {
    const name = addName.trim()
    if (!name) {
      setAddError('Package name is required')
      return
    }
    // Client-side gate (Constraint #361 Rule 5) — validate every dispatch
    if (!isSafePackageName(name)) {
      setAddError('Invalid package name (lowercase, no special chars)')
      return
    }
    setDependency(name, '*', addDev)
    setAddName('')
    setAddError(null)
    // TODO(Phase G): ask the site bridge to install this in the user site.
  }, [addName, addDev, setDependency])

  const handleRuntimeIssueAction = useCallback(
    (issue: RuntimeDependencyIssue) => {
      if (issue.action === 'add') {
        setDependency(issue.packageName, '*', false)
        return
      }

      if (issue.action === 'move-to-runtime') {
        const version = packageJson.devDependencies[issue.packageName] ?? '*'
        setDependency(issue.packageName, version, false)
      }
    },
    [packageJson.devDependencies, setDependency],
  )

  // ── Remove confirmation (Guideline #258) ────────────────────────────────
  const requestRemove = useCallback(
    (name: string, dev: boolean) => {
      setRemoveConfirm({ name, dev })
      // Focus moves to Cancel button on reveal (Guideline #258)
      requestAnimationFrame(() => cancelRef.current?.focus())
    },
    [],
  )

  const confirmRemove = useCallback(() => {
    if (removeConfirm) {
      removeDependency(removeConfirm.name)
      setRemoveConfirm(null)
      // TODO(Phase G): ask the site bridge to remove this from the user site.
    }
  }, [removeConfirm, removeDependency])

  const cancelRemove = useCallback(() => {
    setRemoveConfirm(null)
  }, [])

  const handleRemoveKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancelRemove()
      }
    },
    [cancelRemove],
  )

  // ── Add input validation on change ───────────────────────────────────────
  const handleAddNameChange = useCallback((value: string) => {
    setAddName(value)
    if (!value.trim()) {
      setAddError(null)
      return
    }
    if (!isSafePackageName(value.trim())) {
      setAddError('Invalid package name (use lowercase, hyphens, dots, @ scopes)')
    } else {
      setAddError(null)
    }
  }, [])

  const depCount = totalAll
  const runtimeDependencyCount = Object.keys(packageJson.dependencies).length

  const handleResolveDependencies = useCallback(() => {
    setResolveStatus('resolving')
    setResolveMessage(null)
    resolveCmsRuntimeDependencies(packageJson)
      .then((dependencyLock) => {
        setSiteDependencyLock(dependencyLock)
        setResolveStatus('resolved')
        setResolveMessage(`${Object.keys(dependencyLock.packages).length} locked`)
      })
      .catch((error) => {
        setResolveStatus('error')
        setResolveMessage(error instanceof Error ? error.message : 'Dependency resolution failed')
      })
  }, [packageJson, setSiteDependencyLock])

  const body = (
    <div
      id="deps-section-body"
      className={cn(styles.body, !collapsible && styles.bodyStandalone)}
      data-testid="deps-tab"
    >
      <div>
        <SearchBar
          value={searchQuery}
          onValueChange={setSearchQuery}
          placeholder="Search packages..."
          aria-label="Search packages"
        />
        {/* Live region for search results (Guideline #221) */}
        <div
          aria-live="polite"
          aria-atomic="true"
          className={styles.srLiveRegion}
        >
          {searchQuery
            ? `${totalFiltered} of ${totalAll} packages shown`
            : ''}
        </div>
      </div>

      {/* ─── Package list ──────────────────────────────────────────── */}
      <div className={styles.packageList}>
        {runtimeIssues.length > 0 && (
          <div
            className={styles.runtimeIssues}
            aria-label="Runtime dependency issues"
          >
            {runtimeIssues.map((issue) => (
              <div
                key={`${issue.code}:${issue.packageName}`}
                className={styles.runtimeIssue}
              >
                <span className={styles.runtimeIssueText}>
                  <span className={styles.runtimeIssuePackage}>{issue.packageName}</span>
                  <span>{issue.message}</span>
                </span>
                {issue.action && (
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => handleRuntimeIssueAction(issue)}
                  >
                    {issue.action === 'add' ? 'Add' : 'Move'}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* dependencies section */}
        {filteredDeps.length > 0 && (
          <>
            <div className={styles.sectionLabel}>dependencies</div>
            {filteredDeps.map(([name, version]) => (
              <DepRow
                key={name}
                name={name}
                version={version}
                lockedVersion={lockedPackages[name]?.version}
                dev={false}
                usage={dependencyUsage.get(name)}
                onRemove={requestRemove}
                confirmState={removeConfirm}
                cancelRef={cancelRef}
                onConfirmRemove={confirmRemove}
                onCancelRemove={cancelRemove}
                onKeyDown={handleRemoveKeyDown}
              />
            ))}
          </>
        )}

        {/* devDependencies section */}
        {filteredDevDeps.length > 0 && (
          <>
            <div className={styles.sectionLabel}>devDependencies</div>
            {filteredDevDeps.map(([name, version]) => (
              <DepRow
                key={name}
                name={name}
                version={version}
                dev={true}
                usage={dependencyUsage.get(name)}
                onRemove={requestRemove}
                confirmState={removeConfirm}
                cancelRef={cancelRef}
                onConfirmRemove={confirmRemove}
                onCancelRemove={cancelRemove}
                onKeyDown={handleRemoveKeyDown}
              />
            ))}
          </>
        )}

        {/* Empty / no-results state */}
        {filteredDeps.length === 0 && filteredDevDeps.length === 0 && (
          <div className={styles.emptyMsg}>
            {searchQuery ? `No packages matching "${searchQuery}"` : 'No dependencies yet.'}
          </div>
        )}
      </div>

      {/* ─── Add package form ──────────────────────────────────────── */}
      <div className={styles.addForm}>
        {runtimeDependencyCount > 0 && lockStatus.kind !== 'in-sync' && (
          <div
            className={styles.lockStaleBanner}
            data-testid="deps-lock-stale"
            role="status"
          >
            {describeLockStatus(lockStatus)}
          </div>
        )}
        {runtimeDependencyCount > 0 && (
          <div className={styles.resolveRow}>
            <Button
              variant={lockStatus.kind === 'in-sync' ? 'secondary' : 'primary'}
              size="xs"
              onClick={handleResolveDependencies}
              disabled={displayedResolveStatus === 'resolving'}
            >
              {displayedResolveStatus === 'resolving'
                ? 'Resolving'
                : lockStatus.kind === 'unresolved'
                  ? 'Resolve runtime'
                  : lockStatus.kind === 'stale'
                    ? 'Re-resolve'
                    : 'Resolve runtime'}
            </Button>
            {displayedResolveMessage && (
              <span
                className={styles.resolveStatus}
                data-status={displayedResolveStatus}
                role={displayedResolveStatus === 'error' ? 'alert' : undefined}
              >
                {displayedResolveMessage}
              </span>
            )}
          </div>
        )}

        <div className={styles.addRow}>
          <div className={styles.addInputArea}>
            <div className={styles.addInputWrapper}>
              <PackageIcon size={11} color="var(--editor-text-subtle)" aria-hidden="true" />
              <Input
                data-testid="add-dep-input"
                type="text"
                fieldSize="sm"
                value={addName}
                onChange={(e) => handleAddNameChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddPackage()
                }}
                monospace
                placeholder="package-name"
                aria-label="Add package name"
                aria-describedby={addError ? 'deps-add-error' : undefined}
                invalid={Boolean(addError)}
                className={styles.addInput}
              />
            </div>
            {addError && (
              <div
                id="deps-add-error"
                role="alert"
                className={styles.addError}
              >
                {addError}
              </div>
            )}
          </div>

          <Button
            variant="primary"
            size="xs"
            onClick={handleAddPackage}
            disabled={!!addError || !addName.trim()}
            aria-label="Add dependency"
            tooltip="Add dependency"
          >
            <PlusIcon size={11} aria-hidden="true" />
            Add
          </Button>
        </div>

        {/* dev toggle */}
        <label className={styles.devToggle}>
          <Switch
            checked={addDev}
            onCheckedChange={setAddDev}
            switchSize="sm"
          />
          <span className={styles.devLabel}>devDependency</span>
        </label>
      </div>
    </div>
  )

  return (
    <div
      className={cn(styles.section, !collapsible && styles.sectionStandalone)}
      data-testid="deps-section"
    >
      {!collapsible ? body : (
        <>
      {/* ─── Collapsible section header ────────────────────────────────── */}
      <button
        type="button"
        aria-expanded={isExpanded}
        aria-controls="deps-section-body"
        onClick={() => setIsExpanded((v) => !v)}
        className={styles.sectionToggle}
      >
        <span aria-hidden="true" className={cn(styles.chevron, isExpanded && styles.chevronOpen)}>
          <ChevronRightIcon size={10} />
        </span>
        <span aria-hidden="true" className={styles.sectionIcon}>
          <PackageIcon size={11} />
        </span>
        <span className={styles.sectionTitle}>Dependencies</span>
        {depCount > 0 && (
          <span className={styles.depCount} aria-label={`${depCount} packages`}>
            {depCount}
          </span>
        )}
      </button>

      {/* ─── Section body (collapsed by default) ──────────────────────── */}
      {isExpanded && body}
      </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// DepRow — single dependency row with inline remove confirmation
// ---------------------------------------------------------------------------

interface DepRowProps {
  name: string
  version: string
  lockedVersion?: string
  dev: boolean
  usage?: DependencyUsageSummary
  onRemove: (name: string, dev: boolean) => void
  confirmState: RemoveConfirmState | null
  cancelRef: React.RefObject<HTMLButtonElement | null>
  onConfirmRemove: () => void
  onCancelRemove: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
}

function DepRow({
  name,
  version,
  lockedVersion,
  dev,
  usage,
  onRemove,
  confirmState,
  cancelRef,
  onConfirmRemove,
  onCancelRemove,
  onKeyDown,
}: DepRowProps) {
  const isPendingRemoval = confirmState?.name === name

  if (isPendingRemoval) {
    // Inline confirmation (Guideline #258)
    return (
      <div
        data-testid={`dep-row-${name}`}
        onKeyDown={onKeyDown}
        className={styles.depRowConfirm}
      >
        <span className={styles.depConfirmText}>
          Remove <strong>{name}</strong>?
          {usage && (
            <span className={styles.depConfirmDetail}>
              {' '}Used by {formatDependencyUsage(usage)}.
            </span>
          )}
        </span>
        <Button
          variant="destructive"
          size="sm"
          onClick={onConfirmRemove}
          aria-label={`Confirm remove ${name}`}
        >
          Remove
        </Button>
        <Button
          ref={cancelRef}
          variant="secondary"
          size="sm"
          onClick={onCancelRemove}
          aria-label="Cancel remove"
        >
          Cancel
        </Button>
      </div>
    )
  }

  return (
    <div
      data-testid={`dep-row-${name}`}
      className={styles.depRow}
    >
      <span className={styles.depRowIcon} aria-hidden="true">
        <PackageIcon size={11} />
      </span>
      <span
        className={styles.depName}
        title={name}
      >
        {name}
      </span>
      <span className={styles.depVersion}>
        {version}
        {lockedVersion && lockedVersion !== version && (
          <>
            {' '}
            <span className={styles.depLockedVersion} title={`Locked at ${lockedVersion}`}>
              → {lockedVersion}
            </span>
          </>
        )}
      </span>
      {usage && (
        <span
          className={styles.depUsage}
          title={`Required by ${formatDependencyUsage(usage)}`}
        >
          in use
        </span>
      )}
      <Button
        variant="ghost"
        size="xs"
        iconOnly
        data-testid={`remove-dep-${name}`}
        onClick={() => onRemove(name, dev)}
        aria-label={`Remove ${name}`}
        tooltip={`Remove ${name}`}
      >
        <CloseIcon size={10} aria-hidden="true" />
      </Button>
    </div>
  )
}

function formatModuleUsage(usage: SiteModuleDependencyUsage): string {
  if (usage.modules.length <= 2) return usage.modules.join(', ')
  return `${usage.modules.slice(0, 2).join(', ')} +${usage.modules.length - 2}`
}

function formatScriptUsage(usage: RuntimePackageDependencyUsage): string {
  const paths = usage.files.map((file) => file.path.split('/').pop() ?? file.path)
  if (paths.length <= 2) return paths.join(', ')
  return `${paths.slice(0, 2).join(', ')} +${paths.length - 2}`
}

function formatDependencyUsage(usage: DependencyUsageSummary): string {
  const parts: string[] = []
  if (usage.moduleUsage) parts.push(formatModuleUsage(usage.moduleUsage))
  if (usage.scriptUsage) parts.push(`scripts: ${formatScriptUsage(usage.scriptUsage)}`)
  return parts.join('; ')
}

function combineDependencyUsage(
  moduleUsage: Map<string, SiteModuleDependencyUsage>,
  scriptUsage: Map<string, RuntimePackageDependencyUsage>,
): Map<string, DependencyUsageSummary> {
  const combined = new Map<string, DependencyUsageSummary>()

  for (const [name, usage] of moduleUsage) {
    combined.set(name, { moduleUsage: usage })
  }

  for (const [name, usage] of scriptUsage) {
    const current = combined.get(name)
    combined.set(name, {
      ...current,
      scriptUsage: usage,
    })
  }

  return combined
}

function summarizeRuntimeDependencyIssues(
  diagnostics: SiteRuntimeDiagnostic[],
): RuntimeDependencyIssue[] {
  const issues = new Map<string, RuntimeDependencyIssue>()

  for (const diagnostic of diagnostics) {
    if (!diagnostic.packageName) continue
    if (
      diagnostic.code !== 'runtime-dependency-missing' &&
      diagnostic.code !== 'runtime-dependency-dev-only' &&
      diagnostic.code !== 'runtime-dependency-node-builtin' &&
      diagnostic.code !== 'runtime-dependency-invalid-name'
    ) {
      continue
    }

    const key = `${diagnostic.code}:${diagnostic.packageName}`
    if (issues.has(key)) continue

    const message =
      diagnostic.code === 'runtime-dependency-missing'
        ? 'missing from dependencies'
        : diagnostic.code === 'runtime-dependency-dev-only'
          ? 'declared as devDependency'
          : diagnostic.code === 'runtime-dependency-node-builtin'
            ? 'not available in browser runtime'
            : 'has an invalid package name'
    const action =
      diagnostic.code === 'runtime-dependency-missing'
        ? 'add'
        : diagnostic.code === 'runtime-dependency-dev-only'
          ? 'move-to-runtime'
          : null

    issues.set(key, {
      code: diagnostic.code,
      packageName: diagnostic.packageName,
      message,
      action,
    })
  }

  return [...issues.values()]
}

