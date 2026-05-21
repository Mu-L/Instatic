import { describe, expect, it } from 'bun:test'
import {
  applyPluginPackToSite,
  parsePluginPack,
  PluginPackError,
} from '../../../server/plugins/pack'
import type { SiteDocument } from '@core/page-tree'

const baselineSite: SiteDocument = {
  id: 'default',
  name: 'Test',
  pages: [{
    id: 'home',
    title: 'Home',
    slug: 'index',
    rootNodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        moduleId: 'base.body',
        props: {},
        breakpointOverrides: {},
        children: [],
        classIds: [],
      },
    },
  }],
  breakpoints: [],
  settings: {
    framework: { name: 'none' as const },
    typography: { baseFontSize: '16px', headingScale: '1.25', lineHeight: '1.5' },
    spacing: { baseUnit: '8px' },
    seo: { titleTemplate: '{title}' },
  } as unknown as SiteDocument['settings'],
  classes: {},
  files: [],
  visualComponents: [],
  packageJson: { name: 'site', dependencies: {}, devDependencies: {} },
  runtime: { dependencyLock: { version: 1, packages: {}, updatedAt: 0 }, scripts: {} },
  createdAt: 0,
  updatedAt: 0,
}

describe('parsePluginPack', () => {
  it('rejects classes that are not namespaced under the plugin id', () => {
    expect(() =>
      parsePluginPack('acme.canvas', {
        classes: [{ id: 'foreign-class', name: 'Foreign', styles: {}, breakpointStyles: {}, createdAt: 0, updatedAt: 0 }],
      }),
    ).toThrow(PluginPackError)
  })

  it('accepts classes namespaced with `<pluginId>/`', () => {
    const pack = parsePluginPack('acme.canvas', {
      classes: [{
        id: 'acme.canvas/hero',
        name: 'Hero',
        styles: { color: 'red' },
        breakpointStyles: {},
        createdAt: 0,
        updatedAt: 0,
      }],
    })
    expect(pack.classes.map((c) => c.id)).toEqual(['acme.canvas/hero'])
  })

  it('rejects classes whose name contains whitespace or invalid CSS chars', () => {
    expect(() =>
      parsePluginPack('acme.canvas', {
        classes: [{
          id: 'acme.canvas/hero',
          name: 'My Hero Class',
          styles: {},
          breakpointStyles: {},
          createdAt: 0,
          updatedAt: 0,
        }],
      }),
    ).toThrow(/valid CSS class name/)

    expect(() =>
      parsePluginPack('acme.canvas', {
        classes: [{
          id: 'acme.canvas/hero',
          name: 'hero/with-slash',
          styles: {},
          breakpointStyles: {},
          createdAt: 0,
          updatedAt: 0,
        }],
      }),
    ).toThrow(/valid CSS class name/)
  })

  it('rejects malformed Visual Component entries', () => {
    expect(() =>
      parsePluginPack('acme.canvas', {
        visualComponents: [{ id: '', name: '' }],
      }),
    ).toThrow(PluginPackError)
  })
})

describe('applyPluginPackToSite', () => {
  it('inserts new entries and reports replaced ids', () => {
    const pack = {
      visualComponents: [],
      pages: [],
      classes: [{
        id: 'acme.canvas/hero',
        name: 'Hero',
        styles: { color: 'red' },
        breakpointStyles: {},
        createdAt: 0,
        updatedAt: 0,
      }],
    }

    const { site, replaced } = applyPluginPackToSite(baselineSite, pack)
    expect(site.classes['acme.canvas/hero'].name).toBe('Hero')
    expect(replaced.classes).toEqual([])
  })

  it('replaces existing classes by id and reports the replaced ids', () => {
    const pack = {
      visualComponents: [],
      pages: [],
      classes: [{
        id: 'acme.canvas/hero',
        name: 'Hero v2',
        styles: { color: 'blue' },
        breakpointStyles: {},
        createdAt: 0,
        updatedAt: 0,
      }],
    }
    const seeded: SiteDocument = {
      ...baselineSite,
      classes: {
        'acme.canvas/hero': {
          id: 'acme.canvas/hero',
          name: 'Hero',
          styles: { color: 'red' },
          breakpointStyles: {},
          createdAt: 0,
          updatedAt: 0,
        },
      },
    }
    const { site, replaced } = applyPluginPackToSite(seeded, pack)
    expect(site.classes['acme.canvas/hero'].name).toBe('Hero v2')
    expect(replaced.classes).toEqual(['acme.canvas/hero'])
  })
})
