import {Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Label} from '@plunk/ui';
import {Upload, X} from 'lucide-react';
import {useRef, useState} from 'react';

import {network} from '../../lib/network';

interface ImageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether images can be uploaded (storage is configured). */
  canUpload: boolean;
  /** Inserts the chosen image into the email. */
  onInsert: (src: string) => void;
}

/** Inserts an image by URL or, with storage configured, by uploading a file. */
export function ImageDialog({open, onOpenChange, canUpload, onInsert}: ImageDialogProps) {
  const [imageUrl, setImageUrl] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImageUpload = async () => {
    if (!imageFile && !imageUrl) return;

    if (imageUrl) {
      // Insert external URL
      onInsert(imageUrl);
      setImageUrl('');
      onOpenChange(false);
    } else if (imageFile) {
      try {
        // Upload to S3/Minio
        const formData = new FormData();
        formData.append('image', imageFile);

        const response = await network.upload<{url: string; key: string}>('POST', '/uploads/image', formData);

        // Insert the uploaded image URL
        onInsert(response.url);
        setImageFile(null);
        onOpenChange(false);
      } catch (error) {
        console.error('Failed to upload image:', error);
        alert('Couldn’t upload the image. Try again.');
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Insert image</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="image-url" className="text-sm font-medium mb-2 block">
              Image URL
            </Label>
            <Input
              id="image-url"
              value={imageUrl}
              onChange={e => setImageUrl(e.target.value)}
              placeholder="https://example.com/image.jpg"
              type="url"
            />
          </div>

          {canUpload && (
            <>
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-neutral-200" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-white px-2 text-neutral-500">Or upload</span>
                </div>
              </div>

              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (file) {
                      setImageFile(file);
                      setImageUrl('');
                    }
                  }}
                  className="hidden"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full"
                >
                  <Upload className="h-4 w-4 mr-2" />
                  Choose file
                </Button>
                {imageFile && (
                  <div className="mt-2 flex items-center justify-between p-2 bg-neutral-50 rounded border border-neutral-200">
                    <span className="text-sm text-neutral-700 truncate">{imageFile.name}</span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setImageFile(null)}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}

          <div className="flex gap-2 justify-end">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={handleImageUpload} disabled={!imageUrl && !imageFile}>
              Insert
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
