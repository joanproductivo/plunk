import type {UploadedImage, UploadedImagesResponse} from '@plunk/types';
import {Button} from '@plunk/ui';
import {useState} from 'react';
import useSWRImmutable from 'swr/immutable';

/** The SWR key of the project's uploaded images, cleared after an upload (see ImageDialog). */
export const UPLOADED_IMAGES_KEY = '/uploads/images';

// Thumbnails are the full images, so they are shown a few at a time
const BATCH = 24;

function describe(image: UploadedImage): string {
  if (image.name) return image.name;
  return image.uploadedAt ? `Uploaded ${new Date(image.uploadedAt).toLocaleDateString()}` : 'Uploaded image';
}

/**
 * The project's uploaded images, latest first, to pick one from. Mounted only once asked for, and
 * listed once per dashboard session: listing is a billed storage request, so neither reopening the
 * dialog nor coming back to the window lists them again.
 */
export function ImageGallery({onPick}: {onPick: (url: string) => void}) {
  // No deduping: right after an upload clears the list, reopening must list it again rather than
  // wait on the request that listed it before
  const {data, error, isLoading} = useSWRImmutable<UploadedImagesResponse>(UPLOADED_IMAGES_KEY, {dedupingInterval: 0});
  const [shown, setShown] = useState(BATCH);

  if (error) {
    return <p className="text-sm text-red-700">{error instanceof Error ? error.message : String(error)}</p>;
  }
  if (isLoading || !data) {
    return <p className="text-sm text-neutral-500">Loading your images…</p>;
  }
  if (data.images.length === 0) {
    return <p className="text-sm text-neutral-500">No images uploaded yet</p>;
  }

  return (
    <div className="space-y-3">
      <div className="grid max-h-72 grid-cols-4 gap-2 overflow-y-auto">
        {data.images.slice(0, shown).map(image => (
          <button
            key={image.url}
            type="button"
            title={describe(image)}
            onClick={() => onPick(image.url)}
            className="overflow-hidden rounded border border-neutral-200 hover:ring-2 hover:ring-neutral-400"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- images hosted in the project's storage */}
            <img
              src={image.url}
              alt={describe(image)}
              width={96}
              height={96}
              loading="lazy"
              decoding="async"
              className="h-24 w-full object-cover"
            />
          </button>
        ))}
      </div>
      {shown < data.images.length && (
        <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => setShown(n => n + BATCH)}>
          Show more
        </Button>
      )}
      {data.truncated && <p className="text-xs text-neutral-500">Showing {data.images.length} of your images</p>}
    </div>
  );
}
