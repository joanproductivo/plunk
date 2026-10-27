import {LINKED_FILE_TYPES, MAX_UPLOAD_BYTES} from '@plunk/shared';
import {Button, Dialog, DialogContent, DialogHeader, DialogTitle} from '@plunk/ui';
import {Files, Upload, X} from 'lucide-react';
import {useRef, useState} from 'react';

import {FileGallery, fileLabel} from './FileGallery';
import {useUpload} from './useUpload';

const EXTENSIONS = Object.keys(LINKED_FILE_TYPES);
const ACCEPT = [...EXTENSIONS.map(extension => `.${extension}`), ...Object.values(LINKED_FILE_TYPES)].join(',');

// The API takes up to MAX_UPLOAD_BYTES, but nginx counts the whole upload request against its own
// 10 MB: the margin leaves room for the rest of the request, so a file is refused here with a reason.
export const MAX_LINKED_FILE_BYTES = MAX_UPLOAD_BYTES - 64 * 1024;

/** Why a file cannot be uploaded to link to, or null when it can. */
export function linkedFileProblem(file: File): string | null {
  const extension = /\.([^.]+)$/.exec(file.name)?.[1]?.toLowerCase();
  if (!extension || !EXTENSIONS.includes(extension)) {
    return 'Choose a PDF, Word, Excel or PowerPoint file (.pdf, .docx, .xlsx, .pptx)';
  }
  if (file.size > MAX_LINKED_FILE_BYTES) {
    return 'Files can be up to 9.9 MB';
  }
  return null;
}

interface FileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Links to the chosen file: its public URL, and a name to show when there is no text to link. */
  onPick: (url: string, name: string) => void;
}

/**
 * Uploads a document (PDF, Word, Excel, PowerPoint) to link to, or picks one uploaded before. While
 * it uploads the dialog stays open: closing it would leave the upload without a link.
 */
export function FileDialog({open, onOpenChange, onPick}: FileDialogProps) {
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onOpenChange={next => (busy && !next ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link to a file</DialogTitle>
        </DialogHeader>
        {/* The content unmounts when the dialog closes, so each opening starts empty */}
        <FileForm
          busy={busy}
          onBusy={setBusy}
          onPick={(url, name) => {
            onPick(url, name);
            onOpenChange(false);
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function FileForm({
  busy,
  onBusy,
  onPick,
  onCancel,
}: {
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onPick: (url: string, name: string) => void;
  onCancel: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [showGallery, setShowGallery] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const upload = useUpload('file');

  const choose = (chosen: File) => {
    const reason = linkedFileProblem(chosen);
    setProblem(reason);
    setFile(reason ? null : chosen);
  };

  const uploadAndLink = async () => {
    if (!file) return;
    onBusy(true);
    setProblem(null);
    try {
      const url = await upload(file);
      onBusy(false);
      onPick(url, file.name);
    } catch (error) {
      onBusy(false);
      setProblem(error instanceof Error ? error.message : 'Couldn’t upload the file. Try again.');
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT}
          aria-label="File to upload"
          onChange={e => {
            const chosen = e.target.files?.[0];
            if (chosen) choose(chosen);
            e.target.value = '';
          }}
          className="hidden"
        />
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
          className="w-full"
        >
          <Upload className="h-4 w-4 mr-2" />
          Choose file
        </Button>
        <p className="mt-1 text-xs text-neutral-500">PDF, Word, Excel or PowerPoint, up to 9.9 MB</p>
        {file && (
          <div className="mt-2 flex items-center justify-between p-2 bg-neutral-50 rounded border border-neutral-200">
            <span className="text-sm text-neutral-700 truncate">{file.name}</span>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setFile(null)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}
        {problem && <p className="mt-2 text-sm text-red-700">{problem}</p>}
      </div>

      {showGallery ? (
        <FileGallery onPick={picked => !busy && onPick(picked.url, fileLabel(picked))} />
      ) : (
        <Button type="button" variant="outline" disabled={busy} onClick={() => setShowGallery(true)} className="w-full">
          <Files className="h-4 w-4 mr-2" />
          My files
        </Button>
      )}

      <div className="flex gap-2 justify-end">
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void uploadAndLink()} disabled={!file || busy}>
          {busy ? 'Uploading…' : 'Upload and link'}
        </Button>
      </div>
    </div>
  );
}
