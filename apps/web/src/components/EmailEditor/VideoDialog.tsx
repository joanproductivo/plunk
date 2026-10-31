import {parseYouTubeLink, type VideoSize, visualAttributeText, youTubeWatchUrl} from '@plunk/shared';
import {Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Label} from '@plunk/ui';
import {useEffect, useRef, useState} from 'react';

import {OptionSelect} from './BlockFields';
import type {VideoAttrs} from './EmailVideo';
import type {BlockDialogProps} from './useBlockDialog';
import {useUpload} from './useUpload';
import {composeVideoPoster, VideoNotFoundError, type VideoPoster} from './videoPoster';

const SIZES: Record<VideoSize, string> = {small: 'Small', medium: 'Medium', large: 'Large'};

/** How wide new videos are: a full column was too wide for a desktop. */
const NEW_VIDEO_SIZE: VideoSize = 'medium';

/** The alt text of a video whose title YouTube does not give. */
const DEFAULT_ALT = 'Vídeo de YouTube';

export function VideoDialog({open, onOpenChange, initial, onSubmit}: BlockDialogProps<VideoAttrs>) {
  // While the poster uploads the dialog stays open: closing it would leave the upload without a block
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onOpenChange={next => (busy && !next ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit video' : 'Insert YouTube video'}</DialogTitle>
        </DialogHeader>
        {/* The content unmounts when the dialog closes, so each opening starts from `initial` */}
        <VideoForm initial={initial} onSubmit={onSubmit} onBusy={setBusy} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

type Poster = {id: string} & (
  | {state: 'loading'}
  | {state: 'ready'; poster: VideoPoster; url: string}
  | {state: 'error'; message: string}
);

function VideoForm({
  initial,
  onSubmit,
  onBusy,
  onCancel,
}: Pick<BlockDialogProps<VideoAttrs>, 'initial' | 'onSubmit'> & {
  onBusy: (busy: boolean) => void;
  onCancel: () => void;
}) {
  const [link, setLink] = useState(initial?.href ?? '');
  const [alt, setAlt] = useState(initial?.alt ?? '');
  const [size, setSize] = useState<VideoSize>(initial?.size ?? NEW_VIDEO_SIZE);
  // Read when a poster arrives: the new video's title fills in the alt text unless it was written
  const altEdited = useRef(false);
  const [poster, setPoster] = useState<Poster | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const upload = useUpload('image');

  // The latest onSubmit, which knows where the block is now, for when an upload ends
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      // A dialog closed from outside, its block deleted, no longer waits for the upload it left
      onBusy(false);
    },
    [onBusy],
  );

  const video = parseYouTubeLink(link);
  const initialId = parseYouTubeLink(initial?.href)?.id ?? null;
  // Editing the same video keeps its poster: only another video is composed and uploaded again
  const needsPoster = video !== null && video.id !== initialId;
  // Composed again only for another video, not for another start
  const posterId = needsPoster ? video.id : null;

  useEffect(() => {
    if (!posterId) return;
    let current = true;
    let url: string | null = null;
    setPoster({id: posterId, state: 'loading'});
    composeVideoPoster({id: posterId, start: null}).then(
      composed => {
        if (!current) return;
        url = URL.createObjectURL(composed.image);
        setPoster({id: posterId, state: 'ready', poster: composed, url});
        if (!altEdited.current) setAlt(composed.title ?? DEFAULT_ALT);
      },
      (error: unknown) => {
        if (!current) return;
        const message =
          error instanceof VideoNotFoundError
            ? 'That video doesn’t exist or isn’t public.'
            : 'Couldn’t load the video’s poster. Try again.';
        setPoster({id: posterId, state: 'error', message});
      },
    );
    return () => {
      current = false;
      if (url) URL.revokeObjectURL(url);
      // Its preview URL is gone, so the poster is composed again if this video comes back
      setPoster(previous => (previous?.id === posterId ? null : previous));
    };
  }, [posterId]);

  const ready = poster?.state === 'ready' && poster.id === video?.id ? poster : null;
  const valid = video !== null && (!needsPoster || ready !== null) && !uploading;

  const submit = async () => {
    if (!valid || !video) return;
    const attrs = {href: youTubeWatchUrl(video), alt: visualAttributeText(alt) || DEFAULT_ALT, size};
    if (!needsPoster && initial) {
      submitRef.current({...initial, ...attrs});
      return;
    }

    setUploading(true);
    setUploadError(null);
    onBusy(true);
    try {
      const src = await upload(ready!.poster.image, `youtube-${video.id}.jpg`);
      // A block deleted meanwhile closes the dialog: its poster stays in "My images", unused
      if (mounted.current) {
        submitRef.current({...attrs, src, width: ready!.poster.width, height: ready!.poster.height});
      }
    } catch {
      if (mounted.current) setUploadError('Couldn’t upload the poster. Try again.');
    } finally {
      if (mounted.current) {
        onBusy(false);
        setUploading(false);
      }
    }
  };

  const previewSrc = ready?.url ?? (!needsPoster ? initial?.src : undefined);

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="video-link" className="text-sm font-medium mb-2 block">
          YouTube link
        </Label>
        <Input
          id="video-link"
          value={link}
          onChange={e => setLink(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=…"
          disabled={uploading}
        />
        {link.trim() !== '' && !video && (
          <p className="mt-1 text-xs text-red-700">Paste a link to a YouTube video, from youtube.com or youtu.be.</p>
        )}
        {video?.start ? (
          <p className="mt-1 text-xs text-neutral-500">Starts at {formatStart(video.start)}.</p>
        ) : (
          video &&
          /[?&#](?:t|start)=[^&#]*[1-9]/.test(link) && (
            <p className="mt-1 text-xs text-neutral-500">
              The start in the link can’t be read, so the video starts at the beginning.
            </p>
          )
        )}
      </div>

      <div className="flex aspect-video items-center justify-center overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50">
        {previewSrc ? (
          // eslint-disable-next-line @next/next/no-img-element -- a poster being composed, or in the project's storage
          <img src={previewSrc} alt="" className="h-full w-full object-contain" />
        ) : poster?.state === 'error' && poster.id === video?.id ? (
          <p className="px-4 text-center text-sm text-red-700">{poster.message}</p>
        ) : (
          <p className="text-sm text-neutral-500">{video ? 'Loading the video…' : 'The video’s poster shows here.'}</p>
        )}
      </div>

      <OptionSelect label="Size" value={size} options={SIZES} onChange={setSize} />

      <div>
        <Label htmlFor="video-alt" className="text-sm font-medium mb-2 block">
          Alt text
        </Label>
        <Input
          id="video-alt"
          value={alt}
          onChange={e => {
            setAlt(e.target.value);
            altEdited.current = true;
          }}
          placeholder={DEFAULT_ALT}
          disabled={uploading}
        />
        <p className="mt-1 text-xs text-neutral-500">Read out by screen readers, and shown where images are off.</p>
      </div>

      {uploadError && <p className="text-xs text-red-700">{uploadError}</p>}

      <div className="flex gap-2 justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={uploading}>
          Cancel
        </Button>
        <Button type="button" onClick={submit} disabled={!valid}>
          {uploading ? 'Uploading…' : initial ? 'Save' : 'Insert'}
        </Button>
      </div>
    </div>
  );
}

function formatStart(seconds: number): string {
  const [hours, minutes, rest] = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}
