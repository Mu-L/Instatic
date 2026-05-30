/**
 * Public surface of the data repository.
 *
 * Split into four modules by responsibility:
 *
 *   shared.ts  — shared mapper helpers (userRefAt, toIso, toIsoOrNull, types)
 *   tables.ts  — data_tables CRUD
 *   rows.ts    — data_rows CRUD (drafts, status, author, move, delete)
 *   publish.ts — data_row_versions + redirects + public-route lookups
 *
 * Domain types (`DataRow`, `DataTable`, `PublishedDataRow`, `DataRowRedirect`,
 * `DataRowVersion`, `DataUserReference`) are TypeBox schemas in
 * `@core/data/schemas` — import them from there.
 * Row shapes and mappers stay co-located with the queries that produce them.
 */

export {
  listDataTables,
  listDataTablesWithCounts,
  getDataTable,
  createDataTable,
  updateDataTable,
  softDeleteDataTable,
} from './tables'

export {
  listDataRows,
  listDataRowsWithFilter,
  searchDataRows,
  getDataRow,
  getDataRowBySlug,
  listDataAuthorOptions,
  createDataRow,
  createDataRowMany,
  saveDataRowDraft,
  saveDataRowDraftMany,
  softDeleteDataRow,
  softDeleteDataRowMany,
  updateDataRowTable,
  updateDataRowStatus,
  updateDataRowAuthor,
  scheduleDataRowPublish,
  cancelScheduledPublish,
  listDuePublishSchedules,
} from './rows'

export type { ListDataRowsFilterOptions, ListDataRowsWithFilterResult } from './rows'

export {
  publishDataRow,
  getPublishedDataRowByRoute,
  getDataRowRedirectByRoute,
} from './publish'

export {
  ensureDefaultEntryTemplate,
  backfillDefaultEntryTemplates,
} from './templateSeeding'
