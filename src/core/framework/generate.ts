import type { StyleRule } from '@core/page-tree'
import type {
  FrameworkColorSettings,
  FrameworkPreferencesSettings,
  FrameworkSpacingSettings,
  FrameworkTypographySettings,
} from './schemas'
import {
  formatFrameworkColorThemeCss,
  generateFrameworkColorUtilityClasses,
  generateFrameworkColorVariableSets,
} from './colors'
import {
  generateFrameworkTypographyUtilityClasses,
  generateFrameworkTypographyVariables,
} from './typography'
import {
  generateFrameworkSpacingUtilityClasses,
  generateFrameworkSpacingVariables,
} from './spacing'
import { resolveFrameworkPreferences } from './preferences'
import { formatCssVariableBlock } from './cssVariables'

export interface FrameworkGenerationSettings {
  colors?: FrameworkColorSettings | null
  typography?: FrameworkTypographySettings | null
  spacing?: FrameworkSpacingSettings | null
  preferences?: FrameworkPreferencesSettings | null
}

export function generateFrameworkRootCss(
  settings: FrameworkGenerationSettings | null | undefined,
): string {
  const preferences = resolveFrameworkPreferences(settings?.preferences)
  const colorVariables = generateFrameworkColorVariableSets(settings?.colors)
  const rootVariables = [
    ...colorVariables.light,
    ...generateFrameworkTypographyVariables(settings?.typography, preferences),
    ...generateFrameworkSpacingVariables(settings?.spacing, preferences),
  ]

  return [
    formatCssVariableBlock(':root', rootVariables),
    formatFrameworkColorThemeCss(colorVariables),
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function generateFrameworkUtilityClasses(
  settings: FrameworkGenerationSettings | null | undefined,
): Record<string, StyleRule> {
  return {
    ...generateFrameworkColorUtilityClasses(settings?.colors),
    ...generateFrameworkTypographyUtilityClasses(settings?.typography),
    ...generateFrameworkSpacingUtilityClasses(settings?.spacing),
  }
}
