import type {UploadedFilesResponse, UploadedObject} from '@plunk/types';
import {Button} from '@plunk/ui';
import {FileText} from 'lucide-react';
import {useState} from 'react';
import useSWRImmutable from 'swr/immutable';

/** The SWR key of the project's uploaded files, cleared after an upload (see useUpload). */
export const UPLOADED_FILES_KEY = '/uploads/files';

const BATCH = 20;

/** A file's name as it was listed: the slug its key keeps, with its extension, which tells a PDF from a deck. */
export function fileLabel(file: UploadedObject): string {
  const extension = file.url.slice(file.url.lastIndexOf('.') + 1);
  return `${file.name ?? 'file'}.${extension}`;
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The project's uploaded files, latest first, to pick one from. Like the image gallery, mounted only
 * once asked for and listed once per dashboard session: listing is a billed storage request.
 */
export function FileGallery({onPick}: {onPick: (file: UploadedObject) => void}) {
  const {data, error, isLoading} = useSWRImmutable<UploadedFilesResponse>(UPLOADED_FILES_KEY, {dedupingInterval: 0});
  const [shown, setShown] = useState(BATCH);

  if (error) {
    return <p className="text-sm text-red-700">{error instanceof Error ? error.message : String(error)}</p>;
  }
  if (isLoading || !data) {
    return <p className="text-sm text-neutral-500">Loading your files…</p>;
  }
  if (data.files.length === 0) {
    return <p className="text-sm text-neutral-500">No files uploaded yet</p>;
  }

  return (
    <div className="space-y-3">
      <ul className="max-h-72 divide-y divide-neutral-100 overflow-y-auto rounded border border-neutral-200">
        {data.files.slice(0, shown).map(file => (
          <li key={file.url}>
            <button
              type="button"
              onClick={() => onPick(file)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-50"
            >
              <FileText className="h-4 w-4 shrink-0 text-neutral-500" />
              <span className="min-w-0 flex-1 truncate text-neutral-800">{fileLabel(file)}</span>
              <span className="shrink-0 text-xs text-neutral-500">
                {formatSize(file.size)}
                {file.uploadedAt && ` · ${new Date(file.uploadedAt).toLocaleDateString()}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {shown < data.files.length && (
        <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => setShown(n => n + BATCH)}>
          Show more
        </Button>
      )}
      {data.truncated && <p className="text-xs text-neutral-500">Showing {data.files.length} of your files</p>}
    </div>
  );
}
