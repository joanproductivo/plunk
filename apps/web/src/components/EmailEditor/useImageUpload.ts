import {useSWRConfig} from 'swr';

import {network} from '../../lib/network';
import {UPLOADED_IMAGES_KEY} from './ImageGallery';

/**
 * Uploads an image to the project's storage and resolves to its public URL. `name` is the name
 * it is listed under in "My images", for images that have none of their own, such as a canvas'.
 */
export function useImageUpload() {
  const {mutate} = useSWRConfig();

  return async (image: Blob, name?: string): Promise<string> => {
    const formData = new FormData();
    formData.append('image', name ? new File([image], name, {type: image.type}) : image);

    const response = await network.upload<{url: string; key: string}>('POST', '/uploads/image', formData);

    // The gallery lists it next time it is opened, rather than relisting now
    void mutate(UPLOADED_IMAGES_KEY, undefined, {revalidate: false});
    return response.url;
  };
}
