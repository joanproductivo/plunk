import {
  Button,
  Card,
  CardContent,
  Checkbox,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  IconSpinner,
  Input,
  Label,
  Switch,
} from '@plunk/ui';
import type {Contact} from '@plunk/db';
import {ContactSchemas} from '@plunk/shared';
import type {
  BulkContactActionSelector,
  BulkContactOperation,
  ContactImportResult,
  ContactListFilter,
  ContactSubscriptionStatus,
  CursorPaginatedResponse,
} from '@plunk/types';
import {SEGMENT_IMPORT_ERROR_ROW} from '@plunk/types';
import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table';
import {DashboardLayout} from '../../components/DashboardLayout';
import {ExportContactsButton} from '../../components/ExportContactsButton';
import {BulkActionsDialog} from '../../components/contacts/BulkActionsDialog';
import {useSegments} from '../../components/segments/SegmentPicker';
import {
  BulkActionBar,
  DataTable,
  DataTableColumnHeader,
  DataTableViewOptions,
  DataTableViewSwitcher,
  FilterPill,
  NoResultsState,
  SearchInput,
  isDataTableView,
  type DataTableColumnMeta,
  type DataTableView,
  type FacetedFilterOption,
} from '../../components/data-table';
import {KeyValueEditor} from '../../components/KeyValueEditor';
import {network} from '../../lib/network';
import {ContactStatusBadge, ContactStatusIcon} from '../../lib/contactStatus';
import {formatRelativeTime} from '../../lib/dateUtils';
import {useColumnVisibility} from '../../lib/hooks/useColumnVisibility';
import {usePersistentState} from '../../lib/hooks/usePersistentState';
import {
  AlertTriangle,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Edit,
  EyeOff,
  FileUp,
  ListMinus,
  ListPlus,
  Mail,
  MailCheck,
  MailX,
  Plus,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import {NextSeo} from 'next-seo';
import Link from 'next/link';
import {useEffect, useMemo, useRef, useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';
import dayjs from 'dayjs';

type StatusFilter = 'ALL' | ContactSubscriptionStatus;

const VIEW_STORAGE_KEY = 'plunk:contacts:view';
const COLUMNS_STORAGE_KEY = 'plunk:contacts:columns';

// Fixed-value options for the Status filter pill.
const STATUS_OPTIONS: FacetedFilterOption[] = [
  {value: 'subscribed', label: 'Subscribed'},
  // Snoozed contacts are `subscribed = false` and would otherwise hide inside Unsubscribed,
  // where they read as churn rather than as people who are coming back.
  {value: 'snoozed', label: 'Snoozed'},
  {value: 'unsubscribed', label: 'Unsubscribed'},
];

// select + email + actions are locked-visible (see lockedColumnIds). `updatedAt`
// starts hidden so the Columns menu has a meaningful toggle out of the box.
const DEFAULT_COLUMN_VISIBILITY: VisibilityState = {
  select: true,
  email: true,
  status: true,
  createdAt: true,
  updatedAt: false,
  actions: true,
};

export default function ContactsPage() {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([undefined]);
  const [currentPage, setCurrentPage] = useState(0);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  // Static segment id, or '' for no segment filter
  const [segmentFilter, setSegmentFilter] = useState('');
  const [view, setView] = usePersistentState<DataTableView>(VIEW_STORAGE_KEY, 'table', isDataTableView);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useColumnVisibility(COLUMNS_STORAGE_KEY, DEFAULT_COLUMN_VISIBILITY);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [contactToDelete, setContactToDelete] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [selectedContacts, setSelectedContacts] = useState<Set<string>>(new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [excludedContacts, setExcludedContacts] = useState<Set<string>>(new Set());
  const [showBulkActionsDialog, setShowBulkActionsDialog] = useState(false);
  const [bulkOperation, setBulkOperation] = useState<BulkContactOperation | null>(null);
  const pageSize = 50;

  // Only static segments have members you can filter by and change by hand
  const {data: segments} = useSegments();
  const staticSegments = useMemo(() => (segments ?? []).filter(s => s.type === 'STATIC'), [segments]);

  // The active list filters, as the API's selector takes them. The list below is fetched from
  // these too, so the list, its count, "select all matching", the bulk actions and the export
  // always see the same contacts.
  const listFilter = useMemo<ContactListFilter>(
    () => ({
      ...(search ? {search} : {}),
      ...(statusFilter !== 'ALL' ? {status: statusFilter} : {}),
      ...(segmentFilter ? {segmentId: segmentFilter} : {}),
    }),
    [search, statusFilter, segmentFilter],
  );

  // Backend is authoritative for sorting + filtering (?sort=&dir=, ?status=, ?segmentId=); the
  // client only mirrors the active state.
  const sortParam = sorting[0]?.id ?? '';
  const dirParam = sorting[0] ? (sorting[0].desc ? 'desc' : 'asc') : '';
  const listQuery = [
    `limit=${pageSize}`,
    cursor ? `cursor=${cursor}` : '',
    listFilter.search ? `search=${encodeURIComponent(listFilter.search)}` : '',
    listFilter.status ? `status=${listFilter.status}` : '',
    listFilter.segmentId ? `segmentId=${listFilter.segmentId}` : '',
    sortParam ? `sort=${sortParam}&dir=${dirParam}` : '',
  ]
    .filter(Boolean)
    .join('&');

  const {data, mutate, isLoading} = useSWR<CursorPaginatedResponse<Contact>>(`/contacts?${listQuery}`, {
    revalidateOnFocus: false,
  });

  useEffect(() => {
    if (data) {
      setContacts(data.data);
      if (!cursor) {
        setTotalCount(data.total || data.data.length);
      }
    }
  }, [data, cursor]);

  // Reset the cursor stack — used whenever the query (search/status/segment) or the
  // ordering changes, since cursors are tied to a specific filter + sort.
  const resetPagination = () => {
    setCursor(undefined);
    setCursorHistory([undefined]);
    setCurrentPage(0);
    setContacts([]);
  };

  const clearSelection = () => {
    setSelectedContacts(new Set());
    setSelectAllMatching(false);
    setExcludedContacts(new Set());
  };

  const handleStatusChange = (next: StatusFilter) => {
    setStatusFilter(next);
    resetPagination();
    clearSelection();
  };

  const handleSegmentChange = (next: string) => {
    setSegmentFilter(next);
    resetPagination();
    clearSelection();
  };

  // Sorting only reorders the same matching set, so selection survives; but the
  // cursor stack is tied to the old ordering and must restart from the first page.
  const handleSortingChange: OnChangeFn<SortingState> = updater => {
    setSorting(prev => (typeof updater === 'function' ? updater(prev) : updater));
    resetPagination();
  };

  // Debounced search. Changing the query resets pagination and selection (the
  // matching set changed, so per-id selections no longer make sense).
  useEffect(() => {
    if (searchInput === search) return;
    const timer = setTimeout(() => {
      setSearch(searchInput);
      resetPagination();
      clearSelection();
    }, 350);
    return () => clearTimeout(timer);
  }, [searchInput, search]);

  const handleNextPage = () => {
    if (data?.cursor) {
      const newPage = currentPage + 1;
      setCursor(data.cursor);
      setCurrentPage(newPage);
      // Preserve selection across pages only when "select all matching" is on; otherwise
      // clear, since per-page id sets stop being meaningful once you've left the page.
      if (!selectAllMatching) {
        setSelectedContacts(new Set());
      }

      if (cursorHistory.length <= newPage) {
        setCursorHistory(prev => [...prev, data.cursor]);
      }
    }
  };

  const handlePreviousPage = () => {
    if (currentPage > 0) {
      const newPage = currentPage - 1;
      const previousCursor = cursorHistory[newPage];
      setCursor(previousCursor);
      setCurrentPage(newPage);
      if (!selectAllMatching) {
        setSelectedContacts(new Set());
      }
    }
  };

  // True when the current page's checkbox should appear "all selected"
  const allOnPageSelected = contacts.length > 0 && (
    selectAllMatching
      ? contacts.every(c => !excludedContacts.has(c.id))
      : selectedContacts.size === contacts.length && contacts.every(c => selectedContacts.has(c.id))
  );

  const handleSelectAll = () => {
    if (selectAllMatching) {
      // Toggle: exclude or re-include all on this page
      if (allOnPageSelected) {
        setExcludedContacts(prev => {
          const next = new Set(prev);
          contacts.forEach(c => next.add(c.id));
          return next;
        });
      } else {
        setExcludedContacts(prev => {
          const next = new Set(prev);
          contacts.forEach(c => next.delete(c.id));
          return next;
        });
      }
      return;
    }
    if (allOnPageSelected) {
      setSelectedContacts(new Set());
    } else {
      setSelectedContacts(new Set(contacts.map(c => c.id)));
    }
  };

  const handleSelectContact = (contactId: string) => {
    if (selectAllMatching) {
      setExcludedContacts(prev => {
        const next = new Set(prev);
        if (next.has(contactId)) next.delete(contactId);
        else next.add(contactId);
        return next;
      });
      return;
    }
    setSelectedContacts(prev => {
      const next = new Set(prev);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });
  };

  // Function declaration (hoisted) so the column defs and derived values above
  // can reference it regardless of source order.
  function isContactSelected(contactId: string) {
    return selectAllMatching ? !excludedContacts.has(contactId) : selectedContacts.has(contactId);
  }

  const effectiveSelectionCount = selectAllMatching
    ? Math.max(0, totalCount - excludedContacts.size)
    : selectedContacts.size;

  // What a bulk action targets. "Select all matching" mirrors the active list filters so it
  // reaches exactly the rows the user is looking at, minus the ones they unticked.
  const bulkSelector = useMemo<BulkContactActionSelector>(
    () =>
      selectAllMatching
        ? {mode: 'query', filter: listFilter, excludeIds: Array.from(excludedContacts)}
        : {mode: 'ids', contactIds: Array.from(selectedContacts)},
    [selectAllMatching, listFilter, excludedContacts, selectedContacts],
  );

  // The export takes the selection when there is one, and the whole filtered list otherwise.
  const exportSelector: BulkContactActionSelector =
    effectiveSelectionCount > 0 ? bulkSelector : {mode: 'query', filter: listFilter};

  const handleBulkAction = (operation: BulkContactOperation) => {
    setBulkOperation(operation);
    setShowBulkActionsDialog(true);
  };

  const handleSelectAllMatching = () => {
    setSelectAllMatching(true);
    setSelectedContacts(new Set());
    setExcludedContacts(new Set());
  };

  const promptDelete = (contactId: string) => {
    setContactToDelete(contactId);
    setShowDeleteDialog(true);
  };

  const handleDelete = async () => {
    if (!contactToDelete) return;

    try {
      await network.fetch('DELETE', `/contacts/${contactToDelete}`);
      toast.success('Contact deleted');
      void mutate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t delete the contact. Try again.');
    } finally {
      setContactToDelete(null);
    }
  };

  const hasData = contacts.length > 0;

  // Whether any search/status/segment filter is narrowing the list — drives the
  // "no results vs first-run empty" distinction below.
  const hasActiveFilters = search !== '' || statusFilter !== 'ALL' || segmentFilter !== '';

  // Reset everything that can hide rows (search + status + segment + pagination) so the
  // user can recover from a filter combination that matched nothing.
  const clearFilters = () => {
    setSearchInput('');
    setSearch('');
    setStatusFilter('ALL');
    setSegmentFilter('');
    resetPagination();
    clearSelection();
  };

  const columns = useMemo<Array<ColumnDef<Contact, unknown>>>(
    () => [
      {
        id: 'select',
        enableSorting: false,
        enableHiding: false, // Selection column is locked-visible.
        meta: {label: 'Select', headClassName: 'w-10', cellClassName: 'w-10'} satisfies DataTableColumnMeta,
        header: () => (
          <Checkbox
            aria-label="Select all contacts on this page"
            checked={allOnPageSelected ? true : contacts.some(c => isContactSelected(c.id)) ? 'indeterminate' : false}
            onCheckedChange={handleSelectAll}
          />
        ),
        cell: ({row}) => (
          <Checkbox
            aria-label={`Select ${row.original.email}`}
            checked={isContactSelected(row.original.id)}
            onClick={e => e.stopPropagation()}
            onCheckedChange={() => handleSelectContact(row.original.id)}
          />
        ),
      },
      {
        id: 'email',
        accessorKey: 'email',
        enableHiding: false, // Email column is locked-visible.
        meta: {label: 'Email'} satisfies DataTableColumnMeta,
        header: ({column}) => <DataTableColumnHeader column={column}>Email</DataTableColumnHeader>,
        cell: ({row}) => (
          <div className="flex items-center gap-2">
            <ContactStatusIcon contact={row.original} />
            <Link
              href={`/contacts/${row.original.id}`}
              className="text-sm font-medium text-neutral-900 hover:text-neutral-700 focus-visible:outline-none focus-visible:underline"
            >
              {row.original.email}
            </Link>
          </div>
        ),
      },
      {
        id: 'status',
        accessorKey: 'subscribed',
        enableSorting: false, // Status is faceted-filtered, not sorted.
        meta: {label: 'Status'} satisfies DataTableColumnMeta,
        header: ({column}) => (
          <DataTableColumnHeader
            column={column}
          >
            Status
          </DataTableColumnHeader>
        ),
        cell: ({row}) => (
          <ContactStatusBadge contact={row.original} />
        ),
      },
      {
        id: 'createdAt',
        accessorKey: 'createdAt',
        sortDescFirst: true, // First click surfaces the newest contacts.
        meta: {label: 'Created'} satisfies DataTableColumnMeta,
        header: ({column}) => <DataTableColumnHeader column={column}>Created</DataTableColumnHeader>,
        cell: ({row}) => (
          <div className="group relative inline-block cursor-help text-sm text-neutral-500 whitespace-nowrap">
            {formatRelativeTime(row.original.createdAt)}
            <div className="hidden group-hover:block absolute z-10 w-48 p-2 bg-neutral-900 text-white text-xs rounded shadow-md bottom-full left-1/2 transform -translate-x-1/2 mb-1 whitespace-nowrap">
              {dayjs(row.original.createdAt).format('DD MMMM YYYY, hh:mm')}
            </div>
          </div>
        ),
      },
      {
        id: 'updatedAt',
        accessorKey: 'updatedAt',
        enableSorting: false, // No backend sort field for updatedAt.
        meta: {label: 'Updated'} satisfies DataTableColumnMeta,
        header: ({column}) => <DataTableColumnHeader column={column}>Updated</DataTableColumnHeader>,
        cell: ({row}) => (
          <span className="text-sm text-neutral-500 whitespace-nowrap">
            {formatRelativeTime(row.original.updatedAt)}
          </span>
        ),
      },
      {
        id: 'actions',
        enableSorting: false,
        enableHiding: false, // Actions column is locked-visible.
        meta: {label: 'Actions', headClassName: 'text-right', cellClassName: 'text-right'} satisfies DataTableColumnMeta,
        header: () => <span className="flex justify-end">Actions</span>,
        cell: ({row}) => (
          <div className="flex items-center justify-end gap-1">
            <Button asChild variant="ghost" size="sm" title="Edit contact">
              <Link href={`/contacts/${row.original.id}`} aria-label="Edit contact">
                <Edit className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              title="Delete contact"
              aria-label="Delete contact"
              onClick={() => promptDelete(row.original.id)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ),
      },
    ],
    // Re-create columns when the facet selection or selection model changes so
    // the select-column checkboxes and the Status facet read fresh state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [statusFilter, selectAllMatching, selectedContacts, excludedContacts, contacts, allOnPageSelected],
  );

  const table = useReactTable<Contact>({
    data: contacts,
    columns,
    state: {sorting, columnVisibility},
    onSortingChange: handleSortingChange,
    onColumnVisibilityChange: setColumnVisibility,
    enableRowSelection: false, // Contacts owns a custom select-all-matching model.
    enableMultiSort: false,
    manualSorting: true, // Backend handles sorting; client just exposes ?sort=&dir=.
    getCoreRowModel: getCoreRowModel(),
    getRowId: row => row.id,
  });

  return (
    <>
      <NextSeo title="Contacts" />
      <DashboardLayout>
        <div className="space-y-6">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl sm:text-3xl font-bold text-neutral-900">Contacts</h1>
              <p className="text-neutral-500 mt-2 text-sm sm:text-base">
                Everyone you can send to.{' '}
                {totalCount > 0 ? `${totalCount.toLocaleString()} ${hasActiveFilters ? 'matching' : 'total'}` : ''}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setShowImportDialog(true)} className="flex-1 sm:flex-none">
                <Upload className="h-4 w-4" />
                <span className="hidden sm:inline">Import CSV</span>
                <span className="sm:hidden">Import</span>
              </Button>
              <ExportContactsButton selector={exportSelector} selectionCount={effectiveSelectionCount} />
              <Button onClick={() => setShowCreateDialog(true)} className="flex-1 sm:flex-none">
                <Plus className="h-4 w-4" />
                <span className="hidden sm:inline">Add contact</span>
                <span className="sm:hidden">Add</span>
              </Button>
            </div>
          </div>

          {/* Control row. One aligned cluster of 32px-tall controls:
              - Search input: always present (both views).
              - Status filter: a FilterPill, the same in both views.
              - Segment filter: a FilterPill of the static segments, when there are any.
              - Columns selector: TABLE VIEW ONLY.
              - A hairline divider separates the data controls from the view switcher. */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <SearchInput
              value={searchInput}
              onChange={setSearchInput}
              onClear={() => {
                setSearchInput('');
                setSearch('');
                resetPagination();
              }}
              placeholder="Search by email…"
              className="flex-1"
            />
            <div className="flex items-center gap-2 shrink-0">
              <FilterPill
                title="Status"
                multiple={false}
                options={STATUS_OPTIONS}
                selected={statusFilter === 'ALL' ? [] : [statusFilter]}
                onChange={next => handleStatusChange((next[0] as StatusFilter) ?? 'ALL')}
              />
              {staticSegments.length > 0 && (
                <FilterPill
                  title="Segment"
                  multiple={false}
                  capitalize={false}
                  options={staticSegments.map(segment => ({value: segment.id, label: segment.name}))}
                  selected={segmentFilter ? [segmentFilter] : []}
                  onChange={next => handleSegmentChange(next[0] ?? '')}
                />
              )}
              {view === 'table' && (
                <DataTableViewOptions table={table} lockedColumnIds={['select', 'email', 'actions']} />
              )}
              <span className="hidden sm:block h-5 w-px bg-neutral-200" aria-hidden="true" />
              <DataTableViewSwitcher view={view} onChange={setView} />
            </div>
          </div>

          {/* Bulk action bar — appears in both views once a selection exists.
              Reuses the shared bar; the "select all matching" affordance rides in
              the `note` slot, the three async bulk operations are the children. */}
          {effectiveSelectionCount > 0 && (
            <BulkActionBar
              selectedCount={effectiveSelectionCount}
              itemNoun="contact"
              onClear={clearSelection}
              note={
                !selectAllMatching && allOnPageSelected && totalCount > contacts.length ? (
                  <button
                    type="button"
                    onClick={handleSelectAllMatching}
                    className="text-sm font-medium text-neutral-600 underline-offset-4 transition-colors hover:text-neutral-900 hover:underline focus-visible:outline-none focus-visible:underline focus-visible:text-neutral-900 whitespace-nowrap rounded-sm tabular-nums"
                  >
                    Select all {totalCount.toLocaleString()}
                    {hasActiveFilters ? ' matching' : ''}
                  </button>
                ) : selectAllMatching ? (
                  <span className="text-sm text-neutral-500 whitespace-nowrap">All matching selected</span>
                ) : null
              }
            >
              <Button variant="outline" size="sm" onClick={() => handleBulkAction('subscribe')}>
                <MailCheck className="h-4 w-4" />
                Subscribe
              </Button>
              <Button variant="outline" size="sm" onClick={() => handleBulkAction('unsubscribe')}>
                <MailX className="h-4 w-4" />
                Unsubscribe
              </Button>
              {staticSegments.length > 0 && (
                <>
                  <Button variant="outline" size="sm" onClick={() => handleBulkAction('addToSegment')}>
                    <ListPlus className="h-4 w-4" />
                    Add to segment
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => handleBulkAction('removeFromSegment')}>
                    <ListMinus className="h-4 w-4" />
                    Remove from segment
                  </Button>
                </>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleBulkAction('delete')}
                className="text-neutral-700 transition-colors hover:bg-red-50 hover:text-red-700 hover:border-red-200"
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </Button>
            </BulkActionBar>
          )}

          {/* Contacts */}
          <div>
            {isLoading && contacts.length === 0 ? (
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-center py-12">
                    <IconSpinner />
                  </div>
                </CardContent>
              </Card>
            ) : !hasData ? (
              <Card>
                <CardContent>
                  {hasActiveFilters ? (
                    // Items exist, but the active search/status/segment filters matched
                    // none — offer a one-click recovery.
                    <NoResultsState icon={Mail} itemNoun="contacts" onClear={clearFilters} />
                  ) : (
                    // Genuinely empty project — first-run state.
                    <EmptyState
                      icon={Mail}
                      title="No contacts yet"
                      description="Add contacts to start tracking engagement."
                      action={
                        <Button onClick={() => setShowCreateDialog(true)}>
                          <Plus className="h-4 w-4" />
                          Add contact
                        </Button>
                      }
                    />
                  )}
                </CardContent>
              </Card>
            ) : view === 'card' ? (
              <>
                {/* Card grid view */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {contacts.map(contact => {
                    const selected = isContactSelected(contact.id);
                    return (
                      <Card
                        key={contact.id}
                        data-state={selected ? 'selected' : undefined}
                        className="flex flex-col transition-colors hover:border-neutral-300 data-[state=selected]:border-neutral-400 data-[state=selected]:bg-neutral-50/60"
                      >
                        <div className="flex items-start gap-3 p-4">
                          <Checkbox
                            className="mt-0.5 shrink-0"
                            checked={selected}
                            onCheckedChange={() => handleSelectContact(contact.id)}
                            aria-label={`Select ${contact.email}`}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-3">
                              <Link
                                href={`/contacts/${contact.id}`}
                                className="flex min-w-0 items-center gap-2 text-sm font-medium text-neutral-900 hover:text-neutral-700 focus-visible:outline-none focus-visible:underline"
                              >
                                <ContactStatusIcon contact={contact} />
                                <span className="truncate">{contact.email}</span>
                              </Link>
                              <div className="shrink-0">
                                <ContactStatusBadge contact={contact} />
                              </div>
                            </div>
                            <div className="mt-3 flex items-center justify-between">
                              <div className="group relative inline-block cursor-help">
                                <span className="text-xs text-neutral-400">
                                  Added {formatRelativeTime(contact.createdAt)}
                                </span>
                                <div className="hidden group-hover:block absolute z-10 w-48 p-2 bg-neutral-900 text-white text-xs rounded shadow-md bottom-full left-0 mb-1 whitespace-nowrap">
                                  {dayjs(contact.createdAt).format('DD MMMM YYYY, hh:mm')}
                                </div>
                              </div>
                              <div className="flex items-center gap-1">
                                <Button asChild variant="ghost" size="sm" title="Edit contact">
                                  <Link href={`/contacts/${contact.id}`} aria-label="Edit contact">
                                    <Edit className="h-4 w-4" />
                                  </Link>
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title="Delete contact"
                                  aria-label="Delete contact"
                                  onClick={() => promptDelete(contact.id)}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          </div>
                        </div>
                      </Card>
                    );
                  })}
                </div>

                {(currentPage > 0 || data?.hasMore) && (
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mt-6">
                    <p className="text-sm text-neutral-500 tabular-nums">
                      Showing {(currentPage * pageSize + 1).toLocaleString()} to{' '}
                      {(currentPage * pageSize + contacts.length).toLocaleString()}
                      {totalCount > 0 ? ` of ${totalCount.toLocaleString()}` : ''}
                    </p>
                    <div className="flex items-center gap-2 justify-center sm:justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handlePreviousPage}
                        disabled={currentPage === 0 || isLoading}
                      >
                        <ChevronLeft className="h-4 w-4" />
                        <span className="hidden sm:inline">Previous</span>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleNextPage}
                        disabled={!data?.hasMore || isLoading}
                      >
                        <span className="hidden sm:inline">Next</span>
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                {/* Table view (tanstack-driven) */}
                <Card>
                  <CardContent className="p-0">
                    <DataTable table={table} getRowSelected={c => isContactSelected(c.id)} />
                  </CardContent>
                </Card>

                {(currentPage > 0 || data?.hasMore) && (
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mt-6">
                    <p className="text-sm text-neutral-500 tabular-nums">
                      Showing {(currentPage * pageSize + 1).toLocaleString()} to{' '}
                      {(currentPage * pageSize + contacts.length).toLocaleString()}
                      {totalCount > 0 ? ` of ${totalCount.toLocaleString()}` : ''}
                    </p>
                    <div className="flex items-center gap-2 justify-center sm:justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handlePreviousPage}
                        disabled={currentPage === 0 || isLoading}
                      >
                        <ChevronLeft className="h-4 w-4" />
                        <span className="hidden sm:inline">Previous</span>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleNextPage}
                        disabled={!data?.hasMore || isLoading}
                      >
                        <span className="hidden sm:inline">Next</span>
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Create Contact Dialog */}
        <CreateContactDialog open={showCreateDialog} onOpenChange={setShowCreateDialog} onSuccess={() => mutate()} />

        {/* Import Contacts Dialog */}
        <ImportContactsDialog open={showImportDialog} onOpenChange={setShowImportDialog} onSuccess={() => mutate()} />

        {/* Bulk Actions Dialog */}
        <BulkActionsDialog
          open={showBulkActionsDialog}
          onOpenChange={setShowBulkActionsDialog}
          operation={bulkOperation}
          selector={bulkSelector}
          targetCount={effectiveSelectionCount}
          segments={staticSegments}
          filteredSegmentId={segmentFilter}
          onSuccess={() => {
            mutate();
            clearSelection();
          }}
        />

        {/* Delete Confirmation Dialog */}
        <ConfirmDialog
          open={showDeleteDialog}
          onOpenChange={setShowDeleteDialog}
          onConfirm={handleDelete}
          title="Delete this contact?"
          description="Their events and email history are deleted too. This can't be undone."
          confirmText="Delete contact"
          variant="destructive"
        />
      </DashboardLayout>
    </>
  );
}

interface CreateContactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

function CreateContactDialog({open, onOpenChange, onSuccess}: CreateContactDialogProps) {
  const [email, setEmail] = useState('');
  const [subscribed, setSubscribed] = useState(true);
  const [customData, setCustomData] = useState<Record<string, string | number | boolean> | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const response = await network.fetch<
        {
          _meta?: {isNew: boolean; isUpdate: boolean};
          email: string;
        },
        typeof ContactSchemas.create
      >('POST', '/contacts', {email, subscribed, data: customData});

      // Show appropriate message based on whether contact was new or updated
      if (response._meta?.isUpdate) {
        toast.success(`Contact ${response.email} already existed and was updated with new data`);
      } else {
        toast.success('Contact created');
      }

      setEmail('');
      setSubscribed(true);
      setCustomData(null);
      onOpenChange(false);
      onSuccess();
    } catch (error) {
      // Plunk Lite: an address refused at sign-up comes with its likely correction
      const suggested = (error as {details?: {suggestedEmail?: unknown}}).details?.suggestedEmail;
      const message = error instanceof Error ? error.message : 'Couldn’t save the contact. Try again.';
      toast.error(typeof suggested === 'string' ? `${message} Suggested: ${suggested}` : message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create new contact</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email address
            <span className="text-red-500"> *</span>
          </Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              placeholder="contact@example.com"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="subscribed" className="font-medium cursor-pointer">
                Subscribed
              </Label>
              <p className="text-xs text-neutral-500 mt-0.5">
                Receive emails from campaigns and workflows.
              </p>
            </div>
            <Switch id="subscribed" checked={subscribed} onCheckedChange={setSubscribed} />
          </div>

          <KeyValueEditor key={open ? 'create' : 'closed'} initialData={customData} onChange={setCustomData} />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create Contact'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface ImportContactsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

function ImportContactsDialog({open, onOpenChange, onSuccess}: ImportContactsDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [, setJobId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'processing' | 'completed' | 'failed'>('idle');
  const [result, setResult] = useState<ContactImportResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [showCloseConfirmDialog, setShowCloseConfirmDialog] = useState(false);

  // Helper function to truncate long file names from the middle
  const truncateFileName = (fileName: string, maxLength: number = 30) => {
    if (fileName.length <= maxLength) return fileName;

    const extension = fileName.substring(fileName.lastIndexOf('.'));
    const nameWithoutExt = fileName.substring(0, fileName.lastIndexOf('.'));
    const charsToShow = maxLength - extension.length - 3; // 3 for "..."
    const frontChars = Math.ceil(charsToShow / 2);
    const backChars = Math.floor(charsToShow / 2);

    return `${nameWithoutExt.substring(0, frontChars)}...${nameWithoutExt.substring(nameWithoutExt.length - backChars)}${extension}`;
  };

  // Clean up polling on unmount or dialog close
  useEffect(() => {
    if (!open) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      // Reset state when dialog closes
      setTimeout(() => {
        setFile(null);
        setJobId(null);
        setProgress(0);
        setStatus('idle');
        setResult(null);
        setErrorMessage(null);
      }, 300);
    }
  }, [open]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      // Validate file type
      if (!selectedFile.name.endsWith('.csv')) {
        toast.error('Please select a CSV file');
        return;
      }

      // Validate file size (5MB max)
      if (selectedFile.size > 5 * 1024 * 1024) {
        toast.error('File size must be less than 5MB');
        return;
      }

      setFile(selectedFile);
      setStatus('idle');
    }
  };

  const pollJobStatus = async (jobId: string) => {
    try {
      const response = await network.fetch<{
        id: string;
        state: string;
        progress: number;
        result: ContactImportResult | null;
        failedReason?: string;
      }>('GET', `/contacts/import/${jobId}`);

      setProgress(response.progress || 0);

      if (response.state === 'completed') {
        setStatus('completed');
        setResult(response.result);
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }

        // Show success message
        if (response.result) {
          const {createdCount, updatedCount, failureCount, segmentsCreated, errors, warnings} = response.result;
          const segmentIssues = errors.filter(error => error.row === SEGMENT_IMPORT_ERROR_ROW).length;
          const parts = [];
          if (createdCount > 0) parts.push(`${createdCount} created`);
          if (updatedCount > 0) parts.push(`${updatedCount} updated`);
          if (failureCount > 0) parts.push(`${failureCount} failed`);
          if (segmentsCreated?.length) parts.push(`${segmentsCreated.length} segments created`);
          if (segmentIssues > 0) parts.push(`${segmentIssues} segment issues`);
          if (warnings?.length) parts.push(`${warnings.length} warning${warnings.length === 1 ? '' : 's'}`);

          toast.success(`Import completed: ${parts.join(', ')}`);
        }

        onSuccess();
      } else if (response.state === 'failed') {
        setStatus('failed');
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
        // Store and show the specific error message if available, otherwise show generic error
        const errorMsg = response.failedReason || 'Import failed. Please check your CSV file and try again.';
        setErrorMessage(errorMsg);
        toast.error(errorMsg);
      } else if (response.state === 'active') {
        setStatus('processing');
      }
    } catch (error) {
      console.error('Failed to poll job status:', error);
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      setStatus('failed');
      toast.error('Lost track of the import. Reopen this dialog to check on it.');
    }
  };

  const handleUpload = async () => {
    if (!file) {
      toast.error('Please select a file to upload');
      return;
    }

    setIsUploading(true);
    setStatus('uploading');

    try {
      const formData = new FormData();
      formData.append('file', file);

      const data = await network.upload<{jobId: string; message: string}>('POST', '/contacts/import', formData);

      setJobId(data.jobId);
      setStatus('processing');

      // Start polling for job status
      pollIntervalRef.current = setInterval(() => {
        void pollJobStatus(data.jobId);
      }, 1000); // Poll every second
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Couldn’t upload the file. Try again.';
      setErrorMessage(errorMsg);
      toast.error(errorMsg);
      setStatus('failed');
    } finally {
      setIsUploading(false);
    }
  };

  const handleClose = () => {
    if (status === 'processing') {
      setShowCloseConfirmDialog(true);
      return;
    }
    onOpenChange(false);
  };

  const confirmClose = () => {
    onOpenChange(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import contacts from CSV</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* Instructions */}
            <div className="text-sm text-neutral-500 space-y-1">
              <p>Required column: <code className="text-neutral-700 bg-neutral-100 px-1 py-0.5 rounded text-xs">email</code>. Optional: <code className="text-neutral-700 bg-neutral-100 px-1 py-0.5 rounded text-xs">subscribed</code> (true/false) and any custom fields. Max 5MB.</p>
              <p>
                A <code className="text-neutral-700 bg-neutral-100 px-1 py-0.5 rounded text-xs">segments</code> column
                adds contacts to the static segments it names (separated by ; or ,), creating missing ones; nobody is
                removed from a segment, and those segments fire no entry events. An ISO 8601{' '}
                <code className="text-neutral-700 bg-neutral-100 px-1 py-0.5 rounded text-xs">createdAt</code> dates new
                contacts; without{' '}
                <code className="text-neutral-700 bg-neutral-100 px-1 py-0.5 rounded text-xs">subscribed</code>, a{' '}
                <code className="text-neutral-700 bg-neutral-100 px-1 py-0.5 rounded text-xs">status</code> such as
                confirmed or unsubscribed decides it, and an unknown one leaves new contacts unsubscribed. Exported
                files import back as they are.
              </p>
            </div>

            {/* File Upload */}
            {status === 'idle' || status === 'failed' ? (
              <div>
                <Label htmlFor="csv-file">Select CSV file</Label>
                <div className="mt-2">
                  <input
                    ref={fileInputRef}
                    id="csv-file"
                    type="file"
                    accept=".csv"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => fileInputRef.current?.click()}
                    type="button"
                  >
                    <FileUp className="h-4 w-4 mr-2" />
                    {file ? truncateFileName(file.name) : 'Choose CSV File'}
                  </Button>
                </div>
              </div>
            ) : null}

            {/* Progress */}
            {(status === 'uploading' || status === 'processing') && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-neutral-600">
                    {status === 'uploading' ? 'Uploading file…' : 'Processing contacts…'}
                  </span>
                  <span className="text-neutral-900 font-medium">{progress}%</span>
                </div>
                <div className="w-full bg-neutral-200 rounded-full h-1.5">
                  <div
                    className="bg-neutral-900 h-1.5 rounded-full transition-all duration-300"
                    style={{width: `${progress}%`}}
                  />
                </div>
              </div>
            )}

            {/* Results */}
            {status === 'completed' && result && (
              <div className="space-y-3">
                <div className="flex items-center gap-1.5 text-sm text-neutral-600">
                  <CheckCircle className="h-4 w-4 text-green-600 flex-shrink-0" />
                  <span>
                    <span className="font-medium text-neutral-900">{result.totalRows}</span> processed —{' '}
                    <span className="text-neutral-900">{result.createdCount}</span> created,{' '}
                    <span className="text-neutral-900">{result.updatedCount}</span> updated
                    {result.failureCount > 0 && (
                      <>, <span className="text-red-600">{result.failureCount}</span> failed</>
                    )}
                  </span>
                </div>
                {(!!result.segmentAssignments || !!result.segmentsCreated?.length) && (
                  <p className="text-sm text-neutral-600">
                    <span className="text-neutral-900">{result.segmentAssignments ?? 0}</span> added to segments
                    {!!result.segmentsCreated?.length && <> · created {result.segmentsCreated.join(', ')}</>}
                  </p>
                )}

                {/* Warnings: rows imported, but not quite as the file said */}
                {!!result.warnings?.length && (
                  <div className="max-h-32 overflow-y-auto border border-amber-200 bg-amber-50 rounded-md">
                    <div className="space-y-0 text-xs text-amber-800">
                      {result.warnings.map((warning, idx) => (
                        <div key={idx} className="flex gap-3 px-3 py-2 border-b border-amber-100 last:border-0">
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-600 flex-shrink-0 mt-px" />
                          <span>{warning}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Error Details */}
                {result.errors && result.errors.length > 0 && (
                  <div className="max-h-40 overflow-y-auto border border-neutral-200 rounded-md">
                    <div className="space-y-0 text-xs text-neutral-600">
                      {result.errors.slice(0, 10).map((error, idx) => (
                        <div key={idx} className="flex gap-3 px-3 py-2 border-b border-neutral-100 last:border-0">
                          <span className="font-mono text-neutral-400 flex-shrink-0">
                            {error.row === SEGMENT_IMPORT_ERROR_ROW ? 'Segment' : `Row ${error.row}`}
                          </span>
                          <span className="text-red-600">
                            {error.row === SEGMENT_IMPORT_ERROR_ROW
                              ? error.error
                              : `${error.email || 'N/A'} — ${error.error}`}
                          </span>
                        </div>
                      ))}
                      {result.errors.length > 10 && (
                        <div className="px-3 py-2 text-neutral-500">
                          +{result.errors.length - 10} more errors
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {status === 'failed' && (
              <div className="flex items-start gap-2 text-sm">
                <XCircle className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0" />
                <p className="text-red-600">{errorMessage || 'Please check your CSV file and try again.'}</p>
              </div>
            )}
          </div>

          <DialogFooter>
            {status === 'idle' || status === 'failed' ? (
              <>
                <Button type="button" variant="outline" onClick={handleClose}>
                  Cancel
                </Button>
                <Button type="button" onClick={handleUpload} disabled={!file || isUploading}>
                  {isUploading ? 'Uploading…' : 'Import Contacts'}
                </Button>
              </>
            ) : status === 'completed' ? (
              <Button type="button" onClick={handleClose}>
                Close
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={handleClose}>
                Close
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={showCloseConfirmDialog}
        onOpenChange={setShowCloseConfirmDialog}
        onConfirm={confirmClose}
        title="Close while the import is running?"
        description="The import keeps running in the background. You just won't see the result here."
        cancelText="Keep watching"
        confirmText="Close anyway"
        icon={EyeOff}
      />
    </>
  );
}
