import {ContactSchemas} from '@plunk/shared';
import type {BulkContactActionSelector} from '@plunk/types';
import {Button} from '@plunk/ui';
import dayjs from 'dayjs';
import {Download, Loader2} from 'lucide-react';
import {useState} from 'react';
import {toast} from 'sonner';

import {network} from '../lib/network';

interface ExportContactsButtonProps {
  /** The contacts to export: the current selection, or everything matching the list filters. */
  selector: BulkContactActionSelector;
  /** Number of selected contacts; 0 exports the filtered list. */
  selectionCount: number;
  /**
   * Plunk Lite: the list is filtered by a status the export cannot filter by (waiting for
   * confirmation), so without a selection it exports the list without that filter, statuses included.
   */
  exportsAll?: boolean;
}

export function ExportContactsButton({selector, selectionCount, exportsAll = false}: ExportContactsButtonProps) {
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      await network.download<typeof ContactSchemas.bulkAction>(
        'POST',
        '/contacts/export',
        `contacts-${dayjs().format('YYYY-MM-DD')}.csv`,
        selector,
      );
      toast.success('Export downloaded');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Export failed');
    } finally {
      setIsExporting(false);
    }
  };

  const label =
    selectionCount > 0
      ? `Export selected (${selectionCount.toLocaleString()})`
      : exportsAll
        ? 'Export CSV (all statuses)'
        : 'Export CSV';

  return (
    <Button
      variant="outline"
      onClick={handleExport}
      disabled={isExporting}
      className="flex-1 sm:flex-none"
      title={
        selectionCount === 0 && exportsAll
          ? 'Exports the list without the status filter: the contacts waiting for confirmation read "pending" in its status column'
          : undefined
      }
    >
      {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
      <span className="hidden sm:inline">{label}</span>
      <span className="sm:hidden">Export</span>
    </Button>
  );
}
