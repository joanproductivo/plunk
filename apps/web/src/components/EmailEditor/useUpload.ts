import type {UploadKind} from '@plunk/types';
import {useSWRConfig} from 'swr';

import {network} from '../../lib/network';
import {UPLOADED_FILES_KEY} from './FileGallery';
import {UPLOADED_IMAGES_KEY} from './ImageGallery';

/**
 * Uploads an image, or a file to link to, to the project's storage and resolves to its public URL.
 * `name` is the name it is listed under in its gallery, for uploads that have none of their own,
 * such as a canvas'.
 */
export function useUpload(kind: UploadKind) {
  const {mutate} = useSWRConfig();

  return async (upload: Blob, name?: string): Promise<string> => {
    const formData = new FormData();
    formData.append(kind, name ? new File([upload], name, {type: upload.type}) : upload);

    const response = await network.upload<{url: string; key: string}>('POST', `/uploads/${kind}`, formData);

    // The gallery lists it next time it is opened, rather than relisting now
    void mutate(kind === 'image' ? UPLOADED_IMAGES_KEY : UPLOADED_FILES_KEY, undefined, {revalidate: false});
    return response.url;
  };
}
