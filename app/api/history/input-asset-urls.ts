import { inputImageFilename, inputThumbFilename } from "@/lib/history-inputs";

/**
 * Build public URLs for a generation's input assets. `urlPrefix` is the
 * already-encoded `/api/history/image/<email>/<YYYY>/<MM>` segment. Thumbnails
 * are always produced; a full image URL is produced for each item whose `ext`
 * is non-null. If NO item has a full, `images` is [] (legacy/thumb-only rows).
 */
export function buildInputAssetUrls(
  urlPrefix: string,
  uuid: string,
  items: { ext: string | null }[]
): { thumbnails: string[]; images: string[] } {
  const thumbnails: string[] = [];
  const images: string[] = [];
  items.forEach((item, i) => {
    thumbnails.push(`${urlPrefix}/${inputThumbFilename(uuid, i)}`);
    if (item.ext) images.push(`${urlPrefix}/${inputImageFilename(uuid, i, item.ext)}`);
  });
  return { thumbnails, images };
}
