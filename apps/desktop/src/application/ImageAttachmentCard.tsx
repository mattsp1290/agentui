import { useEffect, useRef, useState } from 'react';
import type { ImageAttachment, ImageId } from '@agentui/contracts/image';

export function imageSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ImageAttachmentCard({ attachment, read }: {
  readonly attachment: ImageAttachment; readonly read: (imageId: ImageId) => Promise<Uint8Array>;
}) {
  const { imageId, mediaType, name } = attachment;
  // Callers rebuild the reader every render; only a different image should refetch.
  const reader = useRef(read);
  useEffect(() => { reader.current = read; });
  const [preview, setPreview] = useState<{ readonly imageId: ImageId; readonly url: string | null } | null>(null);
  useEffect(() => {
    let live = true, url: string | null = null;
    reader.current(imageId).then(bytes => {
      if (!live) return;
      url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mediaType }));
      setPreview({ imageId, url });
    }, () => { if (live) setPreview({ imageId, url: null }); });
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [imageId, mediaType]);
  const shown = preview?.imageId === imageId ? preview : null;
  return <figure className="image-attachment">
    {shown?.url ? <img src={shown.url} alt={name} /> : <span className="image-preview-status">{shown ? 'Preview unavailable' : 'Loading preview…'}</span>}
    <figcaption>{name} · {imageSize(attachment.byteLength)}</figcaption>
  </figure>;
}
